import type { Db } from '../../db/client';
import type { Logger } from '../../logger';
import type { Photos } from '../files/photos';
import type { StoredPhoto } from '../files/image-variant';
import { deleteUserAndFileRows } from './queries';

/**
 * Deletes a user: their rows in one transaction (the cascade takes their
 * garments, outfits, calendar entries and shares), then their photos'
 * (pending link imports' included)
 * bytes, which no transaction holds (AGENTS.md Gotchas, "The DB cascade
 * deletes rows, never bytes"). POST /auth/delete-account and the seed's
 * `--remove` (src/seed/seed.ts) come through here. Returns how many photos
 * went.
 */
export async function deleteAccount(
  { db, photos, logger }: { db: Db; photos: Photos; logger: Logger },
  userId: number,
): Promise<number> {
  const stored = await deleteUnderEveryOwnerLock(db, logger, userId);
  // After commit: an unlink cannot be rolled back. deleteVariants logs a
  // failure instead of throwing; the nightly reconciliation removes what is
  // left, and the account is gone either way.
  for (const photo of stored) await photos.deleteVariants(photo);
  logger.info(`Deleted user ${userId} and ${stored.length} of their photos`);
  return stored.length;
}

/**
 * How many times a deletion locks again for owners its lock missed
 * (deleteUserAndFileRows). No writer today gives a garment a photo another
 * account uploaded, so a second attempt is already a surprise.
 */
const DELETE_ATTEMPTS = 3;

async function deleteUnderEveryOwnerLock(
  db: Db,
  logger: Logger,
  userId: number,
): Promise<StoredPhoto[]> {
  for (let attempt = 1; ; attempt++) {
    const deleted = await deleteUserAndFileRows(db, userId);
    if ('photos' in deleted) return deleted.photos;
    const owners = deleted.ownersGrew.join(', ');
    if (attempt === DELETE_ATTEMPTS) {
      throw new Error(
        `Deleting user ${userId}: garments of owners ${owners} still came to show their photos after ${attempt} attempts`,
      );
    }
    logger.warn(
      `Deleting user ${userId}: garments of owners ${owners} came to show their photos after the lock; locking them too (attempt ${attempt + 1})`,
    );
  }
}
