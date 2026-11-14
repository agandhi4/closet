import { and, eq, not } from 'drizzle-orm';
import type { Db } from '../db/client';
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
import { identityRefusal } from '../web/files/storage-identity';
import type { Logger } from '../logger';

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
}

export interface ReconciliationReport {
  dryRun: boolean;
  /** Files in storage, photos or not. */
  storedObjects: number;
  /** Distinct photos in storage (an original and its variants are one set). */
  storedPhotoSets: number;
  /** Photo sets in storage with no `file` row. */
  orphanedObjectsDeleted: number;
  /** `file` rows nothing references (photoIsReferenced), deleted with their photo sets. */
  orphanedRowsDeleted: number;
  /** `file` rows whose original is gone from storage; reported, never deleted. */
  missingOriginals: number;
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
 * first and checked by the guard; only then are the orphans deleted.
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
  }: ReconcileOptions = {},
): Promise<ReconciliationReport> {
  const { logger } = deps;
  const startedAt = Date.now();
  const cutoff = new Date(startedAt - olderThanMs);
  logger.info(
    `Storage reconciliation started${dryRun ? ' (dry run)' : ''}, cutoff ${cutoff.toISOString()}`,
  );

  // The directory first: a bare mountpoint (the share not mounted) looks
  // like storage whose every photo is gone. Nothing is read or deleted,
  // pending rows included, and --force does not override (#650).
  const identity = await deps.photos.storage.identityProblem();
  if (identity) {
    return refuse(deps, dryRun, startedAt, identityRefusal(identity));
  }
  // Pending rows before the scan (see planReconciliation), file rows after
  // it, and both before any deletion: the mirror rule below needs them.
  const pendingRows = await pendingPhotoRows(deps.db);
  const scan = await scanStorage(deps.photos);
  const rows = await fileRows(deps.db);
  const mirror = mirrorRefusal(rows.length, scan.photoSets.size);
  if (mirror) return refuse(deps, dryRun, startedAt, mirror);
  return cleanUp(
    deps,
    { pendingRows, rows, ...scan },
    { cutoff, startedAt, dryRun, force },
  );
}

// The run once the directory is proven: the pending pass, the plan, the
// guard, the deletions and the report.
async function cleanUp(
  deps: ReconcileDeps,
  state: ReconciliationState,
  {
    cutoff,
    startedAt,
    dryRun,
    force,
  }: { cutoff: Date; startedAt: number; dryRun: boolean; force: boolean },
): Promise<ReconciliationReport> {
  const { logger } = deps;
  // Link imports next: their orphans are explained, so they are removed
  // outside the guard (an evening of abandoned imports must not stop the
  // clean-up), and the plan below never counts a pending photo.
  const agedPending = await removeAgedPendingPhotos(
    deps,
    state.pendingRows,
    pendingCutoffs(cutoff, startedAt),
    dryRun,
  );
  const plan = planReconciliation(logger, cutoff, state, agedPending, dryRun);
  const refused = force ? undefined : planRefusal(plan);
  if (refused) {
    logger.warn(
      `Storage reconciliation refused to delete anything: ${refused}`,
    );
  }
  const deleted = refused
    ? { rows: 0, objects: 0, superseded: 0 }
    : await removeOrphans(deps, plan, dryRun);
  const pendingRowsWithoutFiles = await removePendingRowsWithoutFiles(
    deps,
    plan.pendingRowsWithoutFiles,
    dryRun,
  );

  const report: ReconciliationReport = {
    dryRun,
    storedObjects: plan.storedObjects,
    storedPhotoSets: plan.photoSets.size,
    orphanedObjectsDeleted: deleted.objects,
    orphanedRowsDeleted: deleted.rows,
    missingOriginals: plan.missingOriginals,
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

function planRefusal(plan: ReconciliationPlan): string | undefined {
  return guardRefusal({
    rows: plan.rowCount,
    storedPhotoSets: plan.photoSets.size - plan.pendingSets,
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
    orphanedObjectsDeleted: 0,
    orphanedRowsDeleted: 0,
    missingOriginals: 0,
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
    `${report.orphanedObjectsDeleted} orphaned photo sets and ${report.orphanedRowsDeleted} orphaned rows ` +
    `${would}deleted, ${report.missingOriginals} rows missing their original, ` +
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
  missingOriginals: number;
  /** Stored photo sets explained by a pending row (never orphans). */
  pendingSets: number;
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
  const missingOriginals = reportMissingOriginals(
    rows.filter((row) => !orphanedIds.has(row.id)),
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
    pendingSets: [...pendingNames].filter((name) => photoSets.has(name)).length,
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
  dryRun: boolean,
): Promise<{ rows: number; objects: number; superseded: number }> {
  const rows = await removeOrphanedRows(deps, plan, dryRun);
  // The files the scan found: a base name alone no longer names them all
  // (variant keys, image-variant.ts).
  for (const [, set] of plan.orphanedSets) {
    const names = set.objects.map((object) => object.name);
    deps.logger.debug(`${deleteVerb(dryRun)} orphaned ${names.join(', ')}`);
    if (!dryRun) await deps.photos.deleteFiles(names);
  }
  let superseded = 0;
  for (const [baseName, names] of plan.superseded) {
    deps.logger.info(
      `${deleteVerb(dryRun)} superseded variants of ${baseName}: ${names.join(', ')}`,
    );
    if (!dryRun) await deps.photos.deleteFiles(names);
    superseded += names.length;
  }
  return { rows, objects: plan.orphanedSets.length, superseded };
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
  rows: FileRow[],
  photoSets: Map<string, StoredPhotoSet>,
  cutoffIso: string,
  logger: Logger,
): number {
  let missing = 0;
  for (const row of rows) {
    if (row.createdOn >= cutoffIso) continue;
    if (holdsOriginal(photoSets, row.fileName)) continue;
    logger.warn(
      `File row ${row.fileName} (created ${row.createdOn}) has no original in storage`,
    );
    missing += 1;
  }
  return missing;
}
