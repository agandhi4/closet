import type { MultipartFile } from '@fastify/multipart';
import {
  type InitialCutoutColumns,
  initialCutoutState,
} from '../../cutout/state';
import type { Db, Queryable } from '../../db/client';
import { HttpError } from '../errors';
import { parseStoredName } from '../files/image-variant';
import {
  MAX_PENDING_PER_USER,
  recordPendingPhoto,
  takePendingPhoto,
} from '../files/pending-photos';
import type { Photos } from '../files/photos';
import {
  insertPhotoRow,
  lockPhotoName,
  type NewPhotoRow,
  photoRowExists,
} from '../files/queries';
import type { Logger } from '../../logger';
import { type EntryStatus, statusOfClone } from '../../wardrobe/status';
import {
  deleteGarment,
  type GarmentDetail,
  insertGarment,
  lockGarment,
  replacePhotoRow,
} from './queries';
import type { GarmentFields } from './validation';

/**
 * The garment writes that involve photo bytes, which a transaction cannot
 * roll back. The contract (CLAUDE.md Gotchas, "Photo bytes are written
 * before any row"): Photos writes the bytes and returns the `file` row; the
 * row is inserted in the same transaction as the garment write that points
 * at it; if that transaction fails the new bytes are deleted, and bytes a
 * committed write replaced or orphaned are deleted after the commit.
 */

export interface WardrobeDeps {
  db: Db;
  photos: Photos;
  logger: Logger;
  /** Told when a photo was queued (src/cutout/queue.ts). */
  cutouts: { wake(): void };
}

/**
 * Runs `write` in one transaction with `photo`'s row inserted first (its id
 * handed over); if it does not commit, the photo's bytes go too.
 */
async function commitWithPhoto<T>(
  { db, photos, logger }: WardrobeDeps,
  photo: NewPhotoRow & InitialCutoutColumns,
  write: (tx: Queryable, photoId: number) => Promise<T>,
): Promise<T> {
  try {
    return await db.transaction(async (tx) =>
      write(tx, await insertPhotoRow(tx, photo)),
    );
  } catch (error) {
    logger.warn(`Rolled back; removing orphaned upload ${photo.fileName}`);
    await photos.deleteVariants(photo.fileName);
    throw error;
  }
}

/**
 * More rows a new garment's save writes in the garment's own transaction,
 * given its id: a new wishlist item's plan candidate link (34b), so the
 * item never exists on the wishlist without the link it was added for.
 */
export type WithGarment = (
  tx: Queryable,
  garmentId: number,
) => Promise<unknown>;

/**
 * A new garment in `ownerId`'s wardrobe, in the closet or on the wishlist
 * (the form has no photo; it comes next), with `withGarment`'s rows.
 */
export function createGarment(
  { db }: WardrobeDeps,
  ownerId: number,
  fields: GarmentFields,
  status: EntryStatus,
  withGarment?: WithGarment,
): Promise<number> {
  return db.transaction(async (tx) => {
    const id = await insertGarment(tx, ownerId, fields, null, status);
    await withGarment?.(tx, id);
    return id;
  });
}

/**
 * Keeps `fileName`, just stored by this request, as `userId`'s pending
 * photo (src/web/files/pending-photos.ts): its row, which evicts their
 * oldest past MAX_PENDING_PER_USER, bytes included. The one way a pending
 * photo is kept, whichever source stored it (link import's fetch, the add
 * sheet's upload). The bytes are this request's own, so a failed row insert
 * deletes them.
 */
export async function keepPendingPhoto(
  { db, photos, logger }: Pick<WardrobeDeps, 'db' | 'photos' | 'logger'>,
  fileName: string,
  userId: number,
): Promise<void> {
  let evicted: string[];
  try {
    evicted = await recordPendingPhoto(db, fileName, userId);
  } catch (error) {
    await photos.deleteVariants(fileName);
    throw error;
  }
  for (const name of evicted) await photos.deleteVariants(name);
  if (evicted.length > 0) {
    logger.info(
      `User ${userId} is over ${MAX_PENDING_PER_USER} pending photos: evicted ${evicted.join(', ')}`,
    );
  }
}

/**
 * POST /wardrobe/new/photo (the add sheet's camera and library, #97): the
 * multipart photo stored as storeUploadParts stores any garment photo, kept
 * as `userId`'s pending photo for the new garment form to claim. Its name;
 * a 400 without a photo.
 */
export async function stagePhotoUpload(
  deps: Pick<WardrobeDeps, 'db' | 'photos' | 'logger'>,
  parts: AsyncIterable<MultipartFile>,
  userId: number,
): Promise<string> {
  const photo = await deps.photos.storeUploadParts(parts, userId);
  if (!photo) throw new HttpError(400, 'No file uploaded');
  await keepPendingPhoto(deps, photo.fileName, userId);
  deps.logger.info(
    `Photo ${photo.fileName} uploaded by user ${userId}, pending its garment form`,
  );
  return photo.fileName;
}

/**
 * A new garment whose photo was stored before its form was saved: a
 * pending photo (keepPendingPhoto), fetched from a link or uploaded from
 * the add sheet. The form carries the name as its hidden `linkPhoto` (the
 * field's name since link import; cached forms still post it). Here, in
 * one transaction, the pending row goes, the `file` row is inserted (queued
 * for its cutout) and the garment with it, so nothing reaches `garment` or
 * `file` until the form is saved.
 *
 * Undefined when `userId` cannot claim the name: no pending row of theirs
 * (someone else's, or claimed, discarded, evicted or reconciled already),
 * its bytes gone, or already a `file` row. Nothing is written then, and no
 * bytes are ever deleted here: the name came from the client.
 */
export async function createGarmentWithPendingPhoto(
  { db, photos, logger, cutouts }: WardrobeDeps,
  ownerId: number,
  userId: number,
  fields: GarmentFields,
  fileName: string,
  status: EntryStatus,
  withGarment?: WithGarment,
): Promise<number | undefined> {
  const id = await db.transaction(async (tx) => {
    await lockPhotoName(tx, fileName);
    if (await photoRowExists(tx, fileName)) return undefined;
    // The wardrobe's owner owns the row, whoever saves (as replacePhoto).
    const photo = await photos.pendingPhotoRow(fileName, ownerId);
    if (!photo) return undefined;
    if (!(await takePendingPhoto(tx, fileName, userId))) return undefined;
    const photoId = await insertPhotoRow(tx, {
      ...photo,
      ...initialCutoutState('pending'),
    });
    const garmentId = await insertGarment(tx, ownerId, fields, photoId, status);
    await withGarment?.(tx, garmentId);
    return garmentId;
  });
  if (id === undefined) {
    logger.warn(
      `Pending photo ${fileName} could not be claimed by user ${userId}`,
    );
    return undefined;
  }
  logger.info(
    `Garment ${id} photo ${fileName} (a pending photo) queued for background removal`,
  );
  cutouts.wake();
  return id;
}

/**
 * Deletes a pending photo the form no longer shows (link import: another
 * photo was picked, or none). False, deleting nothing, unless `userId` fetched it and
 * it is still pending (no `file` row): only an import of theirs that no
 * garment was saved with goes. Under the name's lock, so a save claiming it
 * at the same moment either wins (nothing is deleted) or finds it gone. The
 * bytes go after the commit.
 */
export async function discardPendingPhoto(
  { db, photos, logger }: WardrobeDeps,
  fileName: string,
  userId: number,
): Promise<boolean> {
  if (parseStoredName(fileName)?.variant !== 'original') return false;
  const discarded = await db.transaction(async (tx) => {
    await lockPhotoName(tx, fileName);
    if (await photoRowExists(tx, fileName)) return false;
    return takePendingPhoto(tx, fileName, userId);
  });
  if (!discarded) {
    logger.warn(
      `Pending photo ${fileName} not discarded: not pending for user ${userId}`,
    );
    return false;
  }
  await photos.deleteVariants(fileName);
  logger.info(`Discarded pending photo ${fileName} of user ${userId}`);
  return true;
}

/**
 * A copy of `source` in the requester's own wardrobe with the posted fields
 * and its own copy of the photo set (bytes and row), owned by the requester.
 * The copy's cutout starts where the source's is (the bytes are the same);
 * a pending one is queued in its own right. A copy of a wishlist item lands
 * on the requester's wishlist, anything else in their closet (statusOfClone).
 */
export async function cloneGarment(
  deps: WardrobeDeps,
  source: GarmentDetail,
  requesterId: number,
  fields: GarmentFields,
): Promise<number> {
  // copy() is undefined when the source's bytes are gone: a clone without a photo.
  const photo = source.photo
    ? await deps.photos.copy(source.photo.fileName, requesterId)
    : undefined;
  const entry = statusOfClone(source.status);
  if (!photo || !source.photo) {
    return insertGarment(deps.db, requesterId, fields, null, entry);
  }
  const cutout = source.photo.cutoutStatus;
  const id = await commitWithPhoto(
    deps,
    { ...photo, ...initialCutoutState(cutout) },
    (tx, photoId) => insertGarment(tx, requesterId, fields, photoId, entry),
  );
  if (cutout === 'pending') deps.cutouts.wake();
  return id;
}

/**
 * POST /wardrobe/:id/photo: stores the multipart photo, queues its cutout,
 * points the garment at it and removes the photo it replaces, rows in one
 * transaction and the old bytes after it. The new `file` row belongs to the
 * wardrobe's owner, whoever uploads (their account deletion takes it). A
 * 404 when the garment left the wardrobe meanwhile, a 400 without a photo.
 */
export async function replacePhoto(
  deps: WardrobeDeps,
  id: number,
  ownerId: number,
  parts: AsyncIterable<MultipartFile>,
): Promise<void> {
  const photo = await deps.photos.storeUploadParts(parts, ownerId);
  if (!photo) throw new HttpError(400, 'No file uploaded');
  const replaced = await commitWithPhoto(
    deps,
    // The `request` event: every new photo is queued for its cutout.
    { ...photo, ...initialCutoutState('pending') },
    async (tx, photoId) => {
      const locked = await lockGarment(tx, id, ownerId);
      if (!locked) throw new HttpError(404, 'Garment not found');
      await replacePhotoRow(tx, id, photoId, locked.photoId);
      return locked.fileName;
    },
  );
  deps.logger.info(
    `Garment ${id} photo ${photo.fileName} queued for background removal`,
  );
  deps.cutouts.wake();
  if (replaced) {
    await deps.photos.deleteVariants(replaced);
    deps.logger.info(
      `Garment ${id} photo replaced: ${replaced} -> ${photo.fileName}`,
    );
  } else {
    deps.logger.info(`Garment ${id} photo added: ${photo.fileName}`);
  }
}

/**
 * Deletes the garment and its photo's row, then the photo's bytes. False
 * when the garment is not in `ownerId`'s wardrobe.
 */
export async function removeGarment(
  deps: WardrobeDeps,
  id: number,
  ownerId: number,
): Promise<boolean> {
  const fileName = await deleteGarment(deps.db, id, ownerId);
  if (fileName === undefined) return false;
  // Only after commit: an unlink cannot be rolled back.
  if (fileName) await deps.photos.deleteVariants(fileName);
  return true;
}
