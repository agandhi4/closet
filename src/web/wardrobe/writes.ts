import type { MultipartFile } from '@fastify/multipart';
import type { Db, Queryable } from '../../db/client';
import { HttpError } from '../errors';
import type { Photos } from '../files/photos';
import { insertPhotoRow, type NewPhotoRow } from '../files/queries';
import type { WebLogger } from '../logger';
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
  logger: WebLogger;
}

/**
 * Runs `write` in one transaction with `photo`'s row inserted first (its id
 * handed over); if it does not commit, the photo's bytes go too.
 */
async function commitWithPhoto<T>(
  { db, photos, logger }: WardrobeDeps,
  photo: NewPhotoRow,
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

/** A new garment in `ownerId`'s wardrobe (the form has no photo; it comes next). */
export function createGarment(
  { db }: WardrobeDeps,
  ownerId: number,
  fields: GarmentFields,
): Promise<number> {
  return insertGarment(db, ownerId, fields, null);
}

/**
 * A copy of `source` in the requester's own wardrobe with the posted fields
 * and its own copy of the photo set (bytes and row), owned by the requester.
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
  if (!photo) return insertGarment(deps.db, requesterId, fields, null);
  return commitWithPhoto(deps, photo, (tx, photoId) =>
    insertGarment(tx, requesterId, fields, photoId),
  );
}

/**
 * POST /wardrobe/:id/photo: stores the multipart photo (and cutout), points
 * the garment at it and removes the photo it replaces, rows in one
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
  const replaced = await commitWithPhoto(deps, photo, async (tx, photoId) => {
    const locked = await lockGarment(tx, id, ownerId);
    if (!locked) throw new HttpError(404, 'Garment not found');
    await replacePhotoRow(tx, id, photoId, locked.photoId);
    return locked.fileName;
  });
  if (replaced) {
    await deps.photos.deleteVariants(replaced);
    deps.logger.log(
      `Garment ${id} photo replaced: ${replaced} -> ${photo.fileName}`,
    );
  } else {
    deps.logger.log(`Garment ${id} photo added: ${photo.fileName}`);
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
