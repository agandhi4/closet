import type { Db } from '../../db/client';
import type { Logger } from '../../logger';
import { unkeyedPhoto } from '../files/image-variant';
import type { Photos } from '../files/photos';
import { deleteEntry } from './queries';

/**
 * POST /calendar/:id/delete: deletes the owner's entry with its wears and
 * its selfie's row (deleteEntry, one transaction), then the selfie's bytes,
 * which no transaction holds (CLAUDE.md Gotchas, "The DB cascade deletes
 * rows, never bytes"). False when the entry is not theirs.
 */
export async function removeEntry(
  { db, photos, logger }: { db: Db; photos: Photos; logger: Logger },
  id: number,
  ownerId: number,
): Promise<boolean> {
  const outcome = await deleteEntry(db, id, ownerId);
  if (outcome === 'not-found') return false;
  // Only after commit: an unlink cannot be rolled back.
  for (const fileName of outcome.selfies) {
    await photos.deleteVariants(unkeyedPhoto(fileName));
  }
  logger.info(
    `Calendar entry ${id} deleted by user ${ownerId}${
      outcome.selfies.length > 0
        ? ` with its selfie ${outcome.selfies.join(', ')}`
        : ''
    }`,
  );
  return true;
}
