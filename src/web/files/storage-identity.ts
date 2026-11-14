import type { Db } from '../../db/client';
import type { Logger } from '../../logger';
import { parseStoredName } from './image-variant';
import { hasPhotoRows } from './queries';
import {
  type IdentityProblem,
  type PhotoStorage,
  STORAGE_MARKER,
  type StorageMarker,
} from './storage';

/**
 * Whether DATA_PATH is the household's photo storage (#650). Contents
 * cannot say: a bare mountpoint (the NFS share not mounted) reads as
 * storage whose every photo is gone, and reconciliation would then act on
 * it while uploads landed where the remount hides them. So the directory
 * carries a marker (STORAGE_MARKER), written only when this process can
 * prove the directory is the right one:
 *   - the `file` table is empty: a first boot, nothing to lose;
 *   - rows exist and so do stored photos: an existing share from before
 *     the marker, adopted.
 * Rows and no photos, unmarked, is the unmounted share: refused, and the
 * marker is never written there.
 *
 * Called by createPhotos, so the server's boot and every CLI that writes
 * photos (reconcile, retrim, seed) refuse the same directory.
 */
export async function claimStorage(
  storage: PhotoStorage,
  db: Db,
  logger: Logger,
): Promise<StorageMarker> {
  const existing = await storage.readMarker();
  if (existing) {
    storage.claim(existing);
    logger.info(
      `Photo storage ${existing.installId} (marked ${existing.createdAt})`,
    );
    return existing;
  }
  // Only for an unmarked directory: a marked boot sends no statement.
  if (!(await hasPhotoRows(db))) {
    const marker = await storage.writeMarker();
    storage.claim(marker);
    logger.info(
      `Photo storage ${marker.installId}: marked (no photo rows yet: a first boot)`,
    );
    return marker;
  }
  if (await holdsStoredPhoto(storage)) {
    const marker = await storage.writeMarker();
    storage.claim(marker);
    logger.warn(
      `Photo storage ${marker.installId}: adopted an unmarked directory holding photos and their rows`,
    );
    return marker;
  }
  throw new StorageIdentityError('absent');
}

/** Where an operator reads what the marker is and how to re-adopt. */
export const STORAGE_MARKER_FIX = 'docs/operations.md#photo-storage-marker';

/**
 * The refusal, naming the key and never its value (the boot logged that
 * already): main.ts logs the message alone, like a ConfigError.
 */
export class StorageIdentityError extends Error {
  constructor(readonly problem: IdentityProblem) {
    super(identityRefusal(problem));
    this.name = 'StorageIdentityError';
  }
}

/** One wording for the boot, readiness's log line and reconciliation. */
export function identityRefusal(problem: IdentityProblem): string {
  return problem === 'absent'
    ? `DATA_PATH has no ${STORAGE_MARKER} marker: ` +
        `the photo share is not mounted, or DATA_PATH is the wrong directory (${STORAGE_MARKER_FIX})`
    : `DATA_PATH holds another install's ${STORAGE_MARKER} than the one this process booted with: ` +
        `a different share was mounted (${STORAGE_MARKER_FIX})`;
}

// The first stored photo ends the listing: one is proof enough.
async function holdsStoredPhoto(storage: PhotoStorage): Promise<boolean> {
  for await (const object of storage.list()) {
    if (parseStoredName(object.name)) return true;
  }
  return false;
}
