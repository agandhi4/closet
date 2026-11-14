import type { Db } from '../../db/client';
import type { Logger } from '../../logger';
import { parseStoredName } from './image-variant';
import { photoRowNames } from './queries';
import {
  type IdentityProblem,
  type PhotoStorage,
  STORAGE_MARKER,
  type StorageMarker,
} from './storage';

/**
 * The share of `file` rows whose photo set an unmarked directory must hold
 * to be adopted. Not "any photo": a bare mountpoint collects stray uploads
 * while the share is unmounted (the very story of #650), so a few sets
 * prove nothing. Not every row either: a row whose original was lost
 * (reconciliation's `missingOriginals`) must not lock a real share out.
 * An existing share holds nearly all of them; a mountpoint with a night's
 * strays holds next to none.
 */
export const ADOPT_MIN_COVERAGE = 0.9;

/**
 * Whether DATA_PATH is the household's photo storage (#650). Contents
 * alone cannot say: a bare mountpoint (the NFS share not mounted) reads as
 * storage whose every photo is gone, and reconciliation would act on it
 * while uploads landed where the remount hides them. So the directory
 * carries a marker (STORAGE_MARKER), written only when this process can
 * prove the directory is the right one:
 *   - the `file` table is empty: a first boot, nothing to lose;
 *   - the directory holds the sets of at least ADOPT_MIN_COVERAGE of the
 *     rows: an existing share from before the marker, adopted.
 * Anything else unmarked is the unmounted share or the wrong directory, and
 * so is a marker that cannot be read: refused, nothing written there.
 *
 * Called by createPhotos, so the server's boot and every CLI that writes
 * photos (reconcile, retrim, seed) refuse the same directory.
 */
export async function claimStorage(
  storage: PhotoStorage,
  db: Db,
  logger: Logger,
): Promise<StorageMarker> {
  const read = await storage.readMarker();
  if (read.state === 'present') {
    storage.claim(read.marker);
    logger.info(
      `Photo storage ${read.marker.installId} (marked ${read.marker.createdAt})`,
    );
    return read.marker;
  }
  if (read.state === 'unreadable') {
    throw new StorageIdentityError({ kind: 'unreadable', code: read.code });
  }
  // Only for an unmarked directory: a marked boot sends no statement.
  const rows = await photoRowNames(db);
  const covered = rows.length === 0 ? 0 : await coveredRows(storage, rows);
  if (rows.length > 0 && covered < rows.length * ADOPT_MIN_COVERAGE) {
    logger.warn(
      `Refusing an unmarked DATA_PATH holding the photos of ${covered} of ${rows.length} rows`,
    );
    throw new StorageIdentityError({ kind: 'absent' });
  }
  // Ours, or the marker a process booting beside this one linked first.
  const marker = await storage.createMarker();
  storage.claim(marker);
  if (rows.length === 0) {
    logger.info(
      `Photo storage ${marker.installId}: marked (no photo rows yet: a first boot)`,
    );
  } else {
    logger.warn(
      `Photo storage ${marker.installId}: adopted an unmarked directory holding the photos of ${covered} of ${rows.length} rows`,
    );
  }
  return marker;
}

/** Where an operator reads what the marker is and how to re-adopt. */
export const STORAGE_MARKER_FIX = 'docs/operations.md#photo-storage-marker';

/**
 * The refusal, naming the key and never its value (the boot logged that
 * already): main.ts logs it through identityRefusal, like a ConfigError.
 */
export class StorageIdentityError extends Error {
  constructor(readonly problem: IdentityProblem) {
    super(identityRefusal(problem));
    this.name = 'StorageIdentityError';
  }
}

/** One wording for the boot, readiness's log line and reconciliation. */
export function identityRefusal(problem: IdentityProblem): string {
  switch (problem.kind) {
    case 'absent':
      return (
        `DATA_PATH has no ${STORAGE_MARKER} marker: ` +
        `the photo share is not mounted, or DATA_PATH is the wrong directory (${STORAGE_MARKER_FIX})`
      );
    case 'foreign':
      return (
        `DATA_PATH holds another install's ${STORAGE_MARKER} than the one this process booted with: ` +
        `a different share was mounted (${STORAGE_MARKER_FIX})`
      );
    case 'unreadable':
      return `DATA_PATH storage unreadable: ${problem.code} (${STORAGE_MARKER_FIX})`;
  }
}

// How many rows have any file of their set in storage, from one listing.
async function coveredRows(
  storage: PhotoStorage,
  rows: readonly string[],
): Promise<number> {
  const stored = new Set<string>();
  for await (const object of storage.list()) {
    const parsed = parseStoredName(object.name);
    if (parsed) stored.add(parsed.baseName);
  }
  return rows.filter((name) => stored.has(name)).length;
}
