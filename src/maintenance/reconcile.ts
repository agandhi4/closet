import {
  and,
  count,
  eq,
  inArray,
  isNotNull,
  isNull,
  not,
  or,
  sql,
} from 'drizzle-orm';
import { garmentOwnersOf } from '../cutout/queries';
import type { Db } from '../db/client';
import { ownersLockCte } from '../db/owner-lock';
import { file } from '../db/schema';
import {
  parseStoredName,
  type StoredPhoto,
  unkeyedPhoto,
} from '../web/files/image-variant';
import {
  deletePendingPhotoRow,
  isAgedPending,
  type PendingCutoffs,
  pendingCutoffs,
  pendingPhotoRows,
  takeAgedPendingPhotos,
} from '../web/files/pending-photos';
import { photoRowExists, STORED_PHOTO_COLUMNS } from '../web/files/queries';
import { photoIsReferenced } from '../web/files/references';
import type { Photos } from '../web/files/photos';
import type { StoredObject } from '../web/files/storage';
import {
  identityRefusal,
  storageIdentityProblem,
} from '../web/files/storage-identity';
import type { Logger } from '../logger';
import { endWhole } from '../metrics/partial-failure';
import { type IsoDate, todayIn } from '../calendar-date';
import { purgeTrash } from './trash';

// Younger objects and rows are left alone: an upload writes its bytes before
// its row exists, and a delete removes the row before the bytes, so anything
// under a day old may simply be in flight.
export const DEFAULT_OLDER_THAN_MS = 24 * 60 * 60 * 1000;

/**
 * The deletion guard. A run that would delete more than this many photo
 * sets, or more than this fraction of the stored ones, deletes nothing: that
 * is not the trickle of failed uploads reconciliation exists for, it is the
 * database and the disk disagreeing wholesale (a restore, the wrong
 * DATABASE_*). The fraction applies from FRACTION_FLOOR sets up, so a young
 * wardrobe with one stray upload is still cleaned. `--force` overrides.
 */
export const GUARD_MAX_SETS = 25;
export const GUARD_MAX_FRACTION = 0.2;
export const GUARD_FRACTION_FLOOR = 5;

export interface ReconcileOptions {
  olderThanMs?: number;
  /** Count and log what would change without deleting anything. */
  dryRun?: boolean;
  /** Delete even when the guard refuses (the operator has looked). */
  force?: boolean;
  /** The run's clock: the cutoff, the quarantine's day and the purge's. */
  now?: Date;
}

export interface ReconciliationReport {
  dryRun: boolean;
  /** Files in storage, photos or not. */
  storedObjects: number;
  /** Distinct photos in storage (an original and its variants are one set). */
  storedPhotoSets: number;
  /**
   * Photo sets in storage with no `file` row, moved to `.trash/<today>/`
   * (#649): after a database restore they may be the only copy of photos
   * added since the dump.
   */
  orphanedSetsQuarantined: number;
  /** Quarantined sets past TRASH_RETENTION_DAYS, deleted with their day. */
  trashSetsPurged: number;
  /** `file` rows nothing references (photoIsReferenced), deleted with their photo sets. */
  orphanedRowsDeleted: number;
  /** `file` rows whose original is gone from storage; reported, never deleted. */
  missingOriginals: number;
  /** Their names (the post-restore command lists their garments, #653). */
  missingOriginalPhotos: string[];
  /**
   * Rows newly marked `original_missing_since` (nothing of the photo left
   * to show), and marked rows something of whose photo is stored again.
   * A dry run counts what it would change.
   */
  photosMarkedMissing: number;
  photosNoLongerMissing: number;
  /** The marks could not be written (a lock timeout); set only then. */
  marksFailed?: true;
  /**
   * Pending photos never saved (a `pending_photo` row past its cutoff: the
   * run's, or a week for a batch's drafts), deleted with their photo sets.
   * Explained orphans: outside the guard.
   */
  pendingPhotosDeleted: number;
  /** `pending_photo` rows whose photo set is gone from storage, deleted. */
  pendingRowsWithoutFiles: number;
  /**
   * Cutout and thumb files of a live photo under another variant key than
   * its row's (a cutout write that died before its swap, or whose clean-up
   * failed; a thumb backfilled across a swap), deleted.
   */
  supersededVariantsDeleted: number;
  /** Why the guard refused; set only when it did, and then nothing was deleted. */
  refused?: string;
  durationMs: number;
}

export interface ReconcileDeps {
  db: Db;
  photos: Photos;
  logger: Logger;
  /** APP_TIMEZONE: the quarantine's day directories are household days. */
  timeZone: string;
}

interface StoredPhotoSet {
  objects: StoredObject[];
  newest: Date;
}

interface FileRow extends StoredPhoto {
  id: number;
  createdOn: string;
  /** photoIsReferenced at the read. */
  referenced: boolean;
  /** original_missing_since is set. */
  marked: boolean;
}

/**
 * Keeps storage and the file table describing each other. Four findings,
 * each bounded by `olderThan`:
 *   storage -> rows      photo sets whose base name has no `file` row
 *   rows -> references   `file` rows nothing references: no garment's photo,
 *                        no outfit selfie (photoIsReferenced, the one list)
 *   rows -> storage      `file` rows whose original is missing (reported only)
 *   rows -> variants     a live photo's cutout and thumb files under another
 *                        variant key than its row's (superseded)
 * An unreferenced row is an orphan by definition. Everything is planned
 * first and checked by the guard; only then are the orphans removed. A row
 * is the photo's whole explanation, so an unreferenced row's set is
 * deleted; a set with no row may be the one copy of a photo whose row a
 * database restore lost, so it is quarantined (`.trash/<today>/`, purged
 * after TRASH_RETENTION_DAYS by the same run; trash.ts), never deleted.
 *
 * Link imports' pending photos (`pending_photo`, bytes without a `file`
 * row) are not unexplained orphans: day-old ones (a batch's drafts:
 * week-old, pendingCutoffs) go with their rows in a pass of their own
 * before the plan, outside the guard, and younger ones are left out of the
 * plan. Pending rows whose bytes are gone are deleted.
 *
 * Before any of it the directory must be the household's storage (#650):
 * no marker (an unmounted share), another install's marker, or file rows
 * with not one stored photo set refuse the run whole, `--force` or not.
 *
 * Runs nightly from the server (nightly.ts, server.ts) unless
 * MAINTENANCE_ENABLED is false, and on demand through
 * `npm run maintenance:reconcile` (reconcile.cli.ts).
 */
export async function reconcileStorage(
  deps: ReconcileDeps,
  {
    olderThanMs = DEFAULT_OLDER_THAN_MS,
    dryRun = false,
    force = false,
    now = new Date(),
  }: ReconcileOptions = {},
): Promise<ReconciliationReport> {
  const { logger } = deps;
  const startedAt = Date.now();
  const cutoff = new Date(now.getTime() - olderThanMs);
  logger.info(
    `Storage reconciliation started${dryRun ? ' (dry run)' : ''}, cutoff ${cutoff.toISOString()}`,
  );

  // The directory first: a bare mountpoint (the share not mounted) looks
  // like storage whose every photo is gone. Nothing is read or deleted,
  // pending rows included, and --force does not override (#650). So is a
  // share or database of another install (#833).
  const identity = await storageIdentityProblem(deps.photos.storage, deps.db);
  if (identity) {
    return refuse(deps, dryRun, startedAt, identityRefusal(identity));
  }
  // Pending rows before the scan (see planReconciliation), file rows after
  // it, and both before any deletion: the mirror rule below needs them.
  const pendingRows = await pendingPhotoRows(deps.db);
  const scan = await scanStorage(deps.photos);
  const rows = await fileRows(deps.db);
  const mirror = mirrorRefusal(
    rows.length,
    unpendingSetCount(scan.photoSets, pendingRows),
  );
  if (mirror) return refuse(deps, dryRun, startedAt, mirror);
  return cleanUp(
    deps,
    { pendingRows, rows, ...scan },
    { cutoff, now, startedAt, dryRun, force },
  );
}

/**
 * The nightly run: reconcileStorage, then a PartialFailure when the guard
 * or the directory check refused (nothing was cleaned, whoever is looking
 * must look) or photo rows lack their original bytes, for `timeJob` to
 * record as `failure` (#687). server.ts only: the CLI reports the same
 * facts in its JSON and exit code.
 */
export async function reconcileStorageWhole(
  deps: ReconcileDeps,
  options?: ReconcileOptions,
): Promise<ReconciliationReport> {
  const report = await reconcileStorage(deps, options);
  return endWhole(
    'reconciliation',
    {
      refused: report.refused ? 1 : 0,
      'rows missing their original': report.missingOriginals,
      'missing-photo marks not written': report.marksFailed ? 1 : 0,
    },
    report,
  );
}

// The run once the directory is proven: the pending pass, the plan, the
// guard, the deletions and the report.
async function cleanUp(
  deps: ReconcileDeps,
  state: ReconciliationState,
  {
    cutoff,
    now,
    startedAt,
    dryRun,
    force,
  }: {
    cutoff: Date;
    now: Date;
    startedAt: number;
    dryRun: boolean;
    force: boolean;
  },
): Promise<ReconciliationReport> {
  const { logger } = deps;
  // Link imports next: their orphans are explained, so they are removed
  // outside the guard (an evening of abandoned imports must not stop the
  // clean-up), and the plan below never counts a pending photo.
  const agedPending = await removeAgedPendingPhotos(
    deps,
    state.pendingRows,
    pendingCutoffs(cutoff, now.getTime()),
    dryRun,
  );
  const plan = planReconciliation(logger, cutoff, state, agedPending, dryRun);
  const refused = force ? undefined : planRefusal(plan);
  if (refused) {
    logger.warn(
      `Storage reconciliation refused to delete anything: ${refused}`,
    );
  }
  const today = todayIn(deps.timeZone, now);
  const deleted = refused
    ? { rows: 0, quarantined: 0, superseded: 0 }
    : await removeOrphans(deps, plan, today, dryRun);
  // After the deletions and the quarantine, as a step of its own: a lock
  // timeout here is reported (marksFailed) and costs no deletion. Even when
  // the guard refused: a mark deletes nothing, and a restore is exactly
  // when the guard refuses. The rows deleted as orphans are not in the
  // plan's marks.
  const marksFailed = !dryRun && !(await writeMissingMarks(deps, plan.marks));
  // Not while the guard refuses: storage and the database disagreeing
  // wholesale is exactly when the trash may hold what is needed back.
  const trashSetsPurged = refused
    ? 0
    : await purgeTrash(deps.photos.storage, today, logger, dryRun);
  const pendingRowsWithoutFiles = await removePendingRowsWithoutFiles(
    deps,
    plan.pendingRowsWithoutFiles,
    dryRun,
  );

  const report: ReconciliationReport = {
    dryRun,
    storedObjects: plan.storedObjects,
    storedPhotoSets: plan.photoSets.size,
    orphanedSetsQuarantined: deleted.quarantined,
    trashSetsPurged,
    orphanedRowsDeleted: deleted.rows,
    missingOriginals: plan.missingOriginals.length,
    missingOriginalPhotos: plan.missingOriginals,
    photosMarkedMissing: plan.marks.mark.length,
    photosNoLongerMissing: plan.marks.clear.length,
    ...(marksFailed ? { marksFailed: true as const } : {}),
    pendingPhotosDeleted: agedPending.size,
    pendingRowsWithoutFiles,
    supersededVariantsDeleted: deleted.superseded,
    ...(refused ? { refused } : {}),
    durationMs: Date.now() - startedAt,
  };
  logger.info(summary(report));
  return report;
}

/**
 * The guard's mirror rule: rows and not one stored photo set is storage
 * that is not the household's (an emptied or swapped share), never a
 * trickle to clean. Checked ahead of the pending pass, which would delete
 * every pending row as "without files"; --force does not override it.
 */
function mirrorRefusal(
  rows: number,
  storedPhotoSets: number,
): string | undefined {
  if (rows === 0 || storedPhotoSets > 0) return undefined;
  return (
    `the file table has ${rows} rows while storage holds no photo sets ` +
    '(an emptied or unmounted share?)'
  );
}

// The stored sets that are not a pending upload's: what the mirror rule and
// the guard count as the household's photos (a pending photo is explained
// by its row, so one on a swapped share must not vouch for the rest).
function unpendingSetCount(
  photoSets: ReadonlyMap<string, StoredPhotoSet>,
  pendingRows: readonly { fileName: string }[],
): number {
  const pendingNames = new Set(pendingRows.map((row) => row.fileName));
  return [...photoSets.keys()].filter((name) => !pendingNames.has(name)).length;
}

function planRefusal(plan: ReconciliationPlan): string | undefined {
  return guardRefusal({
    rows: plan.rowCount,
    storedPhotoSets: plan.unpendingSets,
    // A photo with superseded variants counts as a set: a database
    // restored behind its storage makes every newer cutout look
    // superseded, and the guard is what stops that.
    deletions:
      plan.orphanedSets.length +
      plan.orphanedRows.length +
      plan.superseded.size,
  });
}

// A run refused before any deletion: the report of a run that did nothing.
function refuse(
  { logger }: ReconcileDeps,
  dryRun: boolean,
  startedAt: number,
  refused: string,
): ReconciliationReport {
  logger.warn(`Storage reconciliation refused to delete anything: ${refused}`);
  const report: ReconciliationReport = {
    dryRun,
    storedObjects: 0,
    storedPhotoSets: 0,
    orphanedSetsQuarantined: 0,
    trashSetsPurged: 0,
    orphanedRowsDeleted: 0,
    missingOriginals: 0,
    missingOriginalPhotos: [],
    photosMarkedMissing: 0,
    photosNoLongerMissing: 0,
    pendingPhotosDeleted: 0,
    pendingRowsWithoutFiles: 0,
    supersededVariantsDeleted: 0,
    refused,
    durationMs: Date.now() - startedAt,
  };
  logger.info(summary(report));
  return report;
}

function summary(report: ReconciliationReport): string {
  const would = report.dryRun ? 'would be ' : '';
  return (
    `Storage reconciliation ${report.dryRun ? 'dry run ' : ''}done in ${report.durationMs}ms: ` +
    `${report.storedObjects} objects scanned (${report.storedPhotoSets} photo sets), ` +
    `${report.orphanedSetsQuarantined} orphaned photo sets ${would}quarantined, ` +
    `${report.trashSetsPurged} quarantined sets ${would}purged, ` +
    `${report.orphanedRowsDeleted} orphaned rows ${would}deleted, ` +
    `${report.missingOriginals} rows missing their original, ` +
    `${report.photosMarkedMissing} photos ${would}marked missing and ` +
    `${report.photosNoLongerMissing} ${would}unmarked` +
    (report.marksFailed ? ' (marks not written)' : '') +
    ', ' +
    `${report.pendingPhotosDeleted} abandoned link imports and ${report.pendingRowsWithoutFiles} ` +
    `pending rows without files ${would}deleted, ` +
    `${report.supersededVariantsDeleted} superseded variant files ${would}deleted` +
    (report.refused ? ' (refused by the guard)' : '')
  );
}

/**
 * Pending photos never saved: those past their cutoff (isAgedPending), their
 * rows and their photo sets (a set that has a `file` row after all keeps
 * its bytes). Each row is deleted in one statement, so a save claiming the
 * photo at the same moment either wins (no row is returned here) or finds
 * it gone. Returns the names; a dry run deletes nothing.
 */
/** The log lines' verb for a deletion, which a dry run only reports. */
function deleteVerb(dryRun: boolean): string {
  return dryRun ? 'Would delete' : 'Deleting';
}

async function removeAgedPendingPhotos(
  { db, photos, logger }: ReconcileDeps,
  snapshot: readonly {
    fileName: string;
    createdAt: Date;
    batchId: string | null;
  }[],
  cutoffs: PendingCutoffs,
  dryRun: boolean,
): Promise<Set<string>> {
  if (dryRun) {
    return new Set(
      snapshot
        .filter((row) => isAgedPending(row, cutoffs))
        .map((row) => row.fileName),
    );
  }
  const names = await takeAgedPendingPhotos(db, cutoffs);
  for (const name of names) {
    if (await photoRowExists(db, name)) continue;
    logger.debug(`Deleting abandoned link import ${name}`);
    await photos.deleteVariants(unkeyedPhoto(name));
  }
  return new Set(names);
}

async function removePendingRowsWithoutFiles(
  { db, logger }: ReconcileDeps,
  names: readonly string[],
  dryRun: boolean,
): Promise<number> {
  for (const name of names) {
    logger.debug(
      `${deleteVerb(dryRun)} pending row ${name}: its photo set is gone`,
    );
    if (!dryRun) await deletePendingPhotoRow(db, name);
  }
  return names.length;
}

interface ReconciliationPlan {
  storedObjects: number;
  photoSets: Map<string, StoredPhotoSet>;
  rowCount: number;
  /** Rows older than the cutoff that nothing references. */
  orphanedRows: FileRow[];
  /** Photo sets older than the cutoff with no row, by base name. */
  orphanedSets: [string, StoredPhotoSet][];
  /** Live rows past the cutoff whose original is not stored. */
  missingOriginals: string[];
  /** The `original_missing_since` changes (missingMarks), by file id. */
  marks: MissingMarks;
  /** Stored photo sets that no pending row explains. */
  unpendingSets: number;
  /** Pending rows (read before the scan) whose original is not stored. */
  pendingRowsWithoutFiles: string[];
  /** Live rows' superseded variant files (supersededVariants), by base name. */
  superseded: Map<string, string[]>;
}

interface ReconciliationState {
  /** Read before the scan. */
  pendingRows: Awaited<ReturnType<typeof pendingPhotoRows>>;
  /** Read after the scan. */
  rows: readonly FileRow[];
  photoSets: Map<string, StoredPhotoSet>;
  storedObjects: number;
}

function fileRows(db: Db): Promise<FileRow[]> {
  return db
    .select({
      id: file.id,
      ...STORED_PHOTO_COLUMNS,
      createdOn: file.createdOn,
      referenced: photoIsReferenced(file.id),
      marked: sql<boolean>`${file.originalMissingSince} is not null`,
    })
    .from(file);
}

// Decides everything from one read of storage and both tables; deletes
// nothing. The pending rows were read before the scan: a pending photo's
// bytes are written before its row, so a row read first whose original the
// scan does not list really has lost its bytes. The scan ran before the
// pending pass, so the sets that pass deleted (an aged pending photo with
// no `file` row) leave the map here, as if scanned after it.
function planReconciliation(
  logger: Logger,
  cutoff: Date,
  { pendingRows, rows, photoSets, storedObjects }: ReconciliationState,
  agedPending: ReadonlySet<string>,
  dryRun: boolean,
): ReconciliationPlan {
  // created_on is an ISO timestamp as text (NewPhotoRow), so it orders as text.
  const cutoffIso = cutoff.toISOString();
  const knownNames = new Set(rows.map((row) => row.fileName));
  if (!dryRun) {
    for (const name of agedPending) {
      if (!knownNames.has(name)) photoSets.delete(name);
    }
  }
  const pendingNames = new Set(pendingRows.map((row) => row.fileName));
  const pendingRowsWithoutFiles = [...pendingNames].filter(
    (name) => !agedPending.has(name) && !holdsOriginal(photoSets, name),
  );
  const orphanedRows = rows.filter(
    (row) => !row.referenced && row.createdOn < cutoffIso,
  );
  const orphanedSets = [...photoSets].filter(([baseName, set]) => {
    if (knownNames.has(baseName) || pendingNames.has(baseName)) return false;
    if (set.newest >= cutoff) {
      logger.debug(`Keeping recent orphan ${baseName}`);
      return false;
    }
    return true;
  });
  const orphanedIds = new Set(orphanedRows.map((row) => row.id));
  const superseded = supersededVariants(
    rows.filter((row) => !orphanedIds.has(row.id)),
    photoSets,
    cutoff,
    logger,
  );
  const live = rows.filter((row) => !orphanedIds.has(row.id));
  const missingOriginals = reportMissingOriginals(
    live,
    photoSets,
    cutoffIso,
    logger,
  );
  return {
    storedObjects,
    photoSets,
    rowCount: rows.length,
    orphanedRows,
    orphanedSets,
    missingOriginals,
    marks: missingMarks(live, photoSets, cutoffIso),
    unpendingSets: unpendingSetCount(photoSets, pendingRows),
    pendingRowsWithoutFiles,
    superseded,
  };
}

function holdsOriginal(
  photoSets: ReadonlyMap<string, StoredPhotoSet>,
  baseName: string,
): boolean {
  return (
    photoSets
      .get(baseName)
      ?.objects.some((object) => object.name === baseName) ?? false
  );
}

/**
 * A live row's cutout and thumb files under another variant key than the
 * row's (null included: unkeyed ones beside a keyed set) that a cutout
 * write replaced. A set goes only when every file of it is older than the
 * cutoff (a younger one may be a write between its files and its swap,
 * Photos.writeCutout) and older than every file of the set the row points
 * at. Fails safe, never destroying the newest bytes: a set with a cutout
 * newer than the row's is what a database restored behind its storage
 * looks like (the row names an older key), so it is kept and logged (a
 * lone thumb is not: it is derived, and goes by the cutoff alone); a row whose own files
 * are not in storage deletes nothing, since nothing then says which set is
 * the older one.
 */
function supersededVariants(
  rows: readonly FileRow[],
  photoSets: ReadonlyMap<string, StoredPhotoSet>,
  cutoff: Date,
  logger: Logger,
): Map<string, string[]> {
  const superseded = new Map<string, string[]>();
  for (const row of rows) {
    const stale = staleVariantsOf(
      row,
      photoSets.get(row.fileName)?.objects ?? [],
      cutoff,
      logger,
    );
    if (stale.length > 0) superseded.set(row.fileName, stale);
  }
  return superseded;
}

// One row's side of supersededVariants: the names to delete.
function staleVariantsOf(
  row: FileRow,
  objects: readonly StoredObject[],
  cutoff: Date,
  logger: Logger,
): string[] {
  const { current, others } = variantSets(row, objects);
  if (others.size === 0) return [];
  // A keyed set is written whole (nobg and thumb); an unkeyed one may lack
  // either (no cutout, a thumb not backfilled yet), not both.
  if (current.length < (row.variantKey === null ? 1 : 2)) {
    logger.warn(
      `Keeping every variant of ${row.fileName}: the files of its row's variant (${keyLabel(row.variantKey)}) are not in storage`,
    );
    return [];
  }
  const currentOldest = Math.min(
    ...current.map((object) => object.lastModified.getTime()),
  );
  const stale: string[] = [];
  for (const [key, files] of others) {
    if (files.some((object) => object.lastModified >= cutoff)) continue;
    // Only a set with a cutout can be the one copy of anything; a lone
    // thumb is derived (and regenerable) and is what a thumb backfilled
    // across a swap leaves under the old key, newer than the row's set.
    const hasCutout = files.some(
      (object) => parseStoredName(object.name)?.variant === 'nobg',
    );
    if (
      hasCutout &&
      files.some((object) => object.lastModified.getTime() >= currentOldest)
    ) {
      logger.warn(
        `Keeping variant ${keyLabel(key)} of ${row.fileName}: newer than the row's variant (${keyLabel(row.variantKey)}): database restored behind storage?`,
      );
      continue;
    }
    stale.push(...files.map((object) => object.name));
  }
  return stale;
}

// A photo's nobg and thumb files: the row's set, and every other set by its
// key (null: the unkeyed set).
function variantSets(
  row: FileRow,
  objects: readonly StoredObject[],
): { current: StoredObject[]; others: Map<string | null, StoredObject[]> } {
  const current: StoredObject[] = [];
  const others = new Map<string | null, StoredObject[]>();
  for (const object of objects) {
    const parsed = parseStoredName(object.name);
    if (!parsed || parsed.variant === 'original') continue;
    if (parsed.variantKey === row.variantKey) current.push(object);
    else {
      others.set(parsed.variantKey, [
        ...(others.get(parsed.variantKey) ?? []),
        object,
      ]);
    }
  }
  return { current, others };
}

function keyLabel(variantKey: string | null): string {
  return variantKey === null ? 'unkeyed' : `key ${variantKey}`;
}

async function removeOrphans(
  deps: ReconcileDeps,
  plan: ReconciliationPlan,
  today: IsoDate,
  dryRun: boolean,
): Promise<{ rows: number; quarantined: number; superseded: number }> {
  const rows = await removeOrphanedRows(deps, plan, dryRun);
  const quarantined = await quarantineOrphanedSets(
    deps,
    plan.orphanedSets,
    today,
    dryRun,
  );
  let superseded = 0;
  for (const [baseName, names] of plan.superseded) {
    deps.logger.info(
      `${deleteVerb(dryRun)} superseded variants of ${baseName}: ${names.join(', ')}`,
    );
    if (!dryRun) await deps.photos.deleteFiles(names);
    superseded += names.length;
  }
  return { rows, quarantined, superseded };
}

// The files the scan found: a base name alone no longer names them all
// (variant keys, image-variant.ts). One set that cannot be moved is a
// warning and stays for the next run, like an orphaned row.
async function quarantineOrphanedSets(
  { photos, logger }: ReconcileDeps,
  sets: ReconciliationPlan['orphanedSets'],
  today: IsoDate,
  dryRun: boolean,
): Promise<number> {
  let quarantined = 0;
  for (const [baseName, set] of sets) {
    const names = set.objects.map((object) => object.name);
    if (dryRun) {
      logger.info(`Would quarantine orphaned ${names.join(', ')}`);
      quarantined += 1;
      continue;
    }
    try {
      const trashed = await photos.storage.quarantine(baseName, names, today);
      if (!trashed) continue;
      logger.info(
        `Quarantined orphaned ${trashed.files.join(', ')} to .trash/${trashed.day}/${trashed.entry}`,
      );
      quarantined += 1;
    } catch (error) {
      logger.warn({ err: error }, `Could not quarantine orphaned ${baseName}`);
    }
  }
  return quarantined;
}

/**
 * Why a run must not delete, or undefined when it may. Pure, so the
 * thresholds are testable without building a store of 26 photos.
 */
export function guardRefusal({
  rows,
  storedPhotoSets,
  deletions,
}: {
  rows: number;
  storedPhotoSets: number;
  deletions: number;
}): string | undefined {
  if (deletions === 0) return undefined;
  if (rows === 0 && storedPhotoSets > 0) {
    return (
      `the file table is empty while storage holds ${storedPhotoSets} photo sets ` +
      '(wrong database, or a restore without its rows?)'
    );
  }
  if (deletions > GUARD_MAX_SETS) {
    return `${deletions} photo sets would go, more than ${GUARD_MAX_SETS} in one run`;
  }
  if (
    deletions > GUARD_FRACTION_FLOOR &&
    deletions > storedPhotoSets * GUARD_MAX_FRACTION
  ) {
    return (
      `${deletions} of ${storedPhotoSets} stored photo sets would go, ` +
      `more than ${GUARD_MAX_FRACTION * 100}% in one run`
    );
  }
  return undefined;
}

// One listing serves every finding; files that are not photos are
// counted and otherwise ignored.
async function scanStorage(photos: Photos): Promise<{
  photoSets: Map<string, StoredPhotoSet>;
  storedObjects: number;
}> {
  const photoSets = new Map<string, StoredPhotoSet>();
  let storedObjects = 0;
  for await (const object of photos.storage.list()) {
    storedObjects += 1;
    const parsed = parseStoredName(object.name);
    if (!parsed) continue;
    const set = photoSets.get(parsed.baseName);
    if (set) {
      set.objects.push(object);
      if (object.lastModified > set.newest) set.newest = object.lastModified;
    } else {
      photoSets.set(parsed.baseName, {
        objects: [object],
        newest: object.lastModified,
      });
    }
  }
  return { photoSets, storedObjects };
}

// Each row goes in one statement that re-checks the references, so a garment
// or selfie attached since the scan keeps its photo. Bytes go after the
// delete; an unlink cannot be rolled back.
async function removeOrphanedRows(
  { db, photos, logger }: ReconcileDeps,
  { orphanedRows: candidates, photoSets }: ReconciliationPlan,
  dryRun: boolean,
): Promise<number> {
  if (dryRun) {
    for (const row of candidates) {
      logger.debug(
        `Would delete unreferenced file ${row.id} (${row.fileName})`,
      );
    }
    return candidates.length;
  }
  let removed = 0;
  for (const candidate of candidates) {
    // One bad row (a dropped connection) must not cancel the whole sweep; it
    // stays a candidate for the next run.
    try {
      const [deleted] = await db
        .delete(file)
        .where(and(eq(file.id, candidate.id), not(photoIsReferenced(file.id))))
        .returning(STORED_PHOTO_COLUMNS);
      if (!deleted) continue;
      logger.debug(
        `Deleted unreferenced file ${candidate.id} (${deleted.fileName})`,
      );
      await photos.deleteVariants(deleted);
      // With whatever else the scan found of it (a superseded variant).
      await photos.deleteFiles(
        (photoSets.get(deleted.fileName)?.objects ?? []).map(
          (object) => object.name,
        ),
      );
      removed += 1;
    } catch (error) {
      logger.warn(
        { err: error },
        `Skipping unreferenced file ${candidate.id} (${candidate.fileName})`,
      );
    }
  }
  return removed;
}

function reportMissingOriginals(
  rows: readonly FileRow[],
  photoSets: ReadonlyMap<string, StoredPhotoSet>,
  cutoffIso: string,
  logger: Logger,
): string[] {
  const missing: string[] = [];
  for (const row of rows) {
    if (row.createdOn >= cutoffIso) continue;
    if (holdsOriginal(photoSets, row.fileName)) continue;
    logger.warn(
      `File row ${row.fileName} (created ${row.createdOn}) has no original in storage`,
    );
    missing.push(row.fileName);
  }
  return missing;
}

/** File ids whose `original_missing_since` a run sets, and clears. */
export interface MissingMarks {
  mark: number[];
  clear: number[];
}

/**
 * Which live rows' `original_missing_since` changes (#653). A row is marked
 * when nothing of its photo is left to show: its original and the nobg and
 * thumb of its row's variant all absent (a thumb alone, or a cutout alone,
 * still shows the garment). Past the cutoff only, like the missing-original
 * report: a younger row's bytes may be in flight. A marked row is cleared
 * as soon as any of them is stored again (a second restore, a share
 * remounted, --restore-from-trash), whatever its age.
 */
function missingMarks(
  rows: readonly FileRow[],
  photoSets: ReadonlyMap<string, StoredPhotoSet>,
  cutoffIso: string,
): MissingMarks {
  const marks: MissingMarks = { mark: [], clear: [] };
  for (const row of rows) {
    const shown = showsSomething(row, photoSets.get(row.fileName)?.objects);
    if (row.marked && shown) marks.clear.push(row.id);
    if (!row.marked && !shown && row.createdOn < cutoffIso) {
      marks.mark.push(row.id);
    }
  }
  return marks;
}

// Whether storage holds anything a page could show of the row's photo.
function showsSomething(
  row: StoredPhoto,
  objects: readonly StoredObject[] = [],
): boolean {
  return objects.some((object) => {
    const parsed = parseStoredName(object.name);
    return (
      parsed !== undefined &&
      (parsed.variant === 'original' || parsed.variantKey === row.variantKey)
    );
  });
}

/**
 * Writes `marks` in one statement under the owners' lock: the photo row is
 * synced data (its garment's revision moves, closet_sync_touch_photo), so
 * every owner of a garment showing one of them is locked first, in id
 * order (ownersLockCte over garmentOwnersOf, the cutout retry's shape). A
 * photo no garment shows (a selfie's, a look's) locks nobody. The WHERE
 * re-asserts each change's condition, so a row another run marked or
 * cleared meanwhile is left as it is. False when it failed (a 55P03 behind
 * a stalled writer): logged, and the next run tries again.
 */
async function writeMissingMarks(
  { db, logger }: ReconcileDeps,
  { mark, clear }: MissingMarks,
): Promise<boolean> {
  const ids = [...mark, ...clear];
  if (ids.length === 0) return true;
  try {
    const lock = ownersLockCte(
      db,
      garmentOwnersOf(
        sql`${sql.join(
          ids.map((id) => sql`${id}::int`),
          sql`, `,
        )}`,
      ),
    );
    const marked = mark.length > 0 ? inArray(file.id, mark) : sql`false`;
    const written = await db
      .with(lock)
      .update(file)
      .set({
        originalMissingSince: sql`case when ${marked} then now() end`,
      })
      .where(
        and(
          // Runs the lock before the scan (an uncorrelated InitPlan, as
          // ownerLocked); `>= 0`, not `> 0`: photos no garment shows
          // have no owner to lock and are written all the same.
          sql`(${db.select({ owners: count() }).from(lock)}) >= 0`,
          or(
            mark.length > 0
              ? and(inArray(file.id, mark), isNull(file.originalMissingSince))
              : undefined,
            clear.length > 0
              ? and(
                  inArray(file.id, clear),
                  isNotNull(file.originalMissingSince),
                )
              : undefined,
          ),
        ),
      )
      .returning({
        fileName: file.fileName,
        missing: file.originalMissingSince,
      });
    for (const row of written) {
      logger.info(
        row.missing
          ? `Photo ${row.fileName} marked missing: nothing of it is in storage`
          : `Photo ${row.fileName} no longer missing: its bytes are back in storage`,
      );
    }
    return true;
  } catch (error) {
    logger.error(
      { err: error },
      `Could not write the missing-photo marks of ${ids.length} photos`,
    );
    return false;
  }
}
