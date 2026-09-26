import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { Db, Queryable } from '../../db/client';
import { pendingPhoto } from '../../db/schema';

/**
 * Link import's pending photos (issue #6): bytes stored when a link was
 * fetched, before the garment form is saved, and the `pending_photo` row
 * that explains them. The row names the user who fetched the photo; only
 * that user may claim it (the save, src/web/wardrobe/writes.ts) or discard
 * it (another pick). Reconciliation removes the ones left a day
 * (src/maintenance/reconcile.ts), counted apart from its deletion guard:
 * an abandoned import is routine, not the database and the disk
 * disagreeing. Account deletion removes a user's with their photos.
 *
 * Nothing here touches bytes: the callers delete a returned name's
 * variants through Photos, after their transaction commits.
 */

/** Pending photos one user may hold; storing another evicts the oldest. */
export const MAX_PENDING_PER_USER = 10;

/**
 * Records `fileName` (just stored) as `userId`'s pending photo and returns
 * the names evicted to keep them within MAX_PENDING_PER_USER, oldest first:
 * their rows are gone, and the caller deletes their bytes. The user's
 * pending photos are serialized by a transaction advisory lock, so two
 * imports at once cannot both keep an eleventh.
 */
export function recordPendingPhoto(
  db: Db,
  fileName: string,
  userId: number,
): Promise<string[]> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`closet:pending-photos:${userId}`}))`,
    );
    await tx.insert(pendingPhoto).values({ fileName, userId });
    const kept = tx
      .select({ fileName: pendingPhoto.fileName })
      .from(pendingPhoto)
      .where(eq(pendingPhoto.userId, userId))
      .orderBy(desc(pendingPhoto.createdAt), desc(pendingPhoto.fileName))
      .limit(MAX_PENDING_PER_USER);
    const evicted = await tx
      .delete(pendingPhoto)
      .where(
        and(
          eq(pendingPhoto.userId, userId),
          sql`${pendingPhoto.fileName} not in ${kept}`,
        ),
      )
      .returning({ fileName: pendingPhoto.fileName });
    return evicted.map((row) => row.fileName);
  });
}

/**
 * Deletes the pending row of `fileName` if `userId` fetched it; false when
 * there is none for that user (someone else's, claimed, discarded, evicted
 * or reconciled). Inside the claim's or the discard's transaction: the row
 * lock orders it against any other taker, so exactly one wins.
 */
export async function takePendingPhoto(
  tx: Queryable,
  fileName: string,
  userId: number,
): Promise<boolean> {
  const taken = await tx
    .delete(pendingPhoto)
    .where(
      and(eq(pendingPhoto.fileName, fileName), eq(pendingPhoto.userId, userId)),
    )
    .returning({ fileName: pendingPhoto.fileName });
  return taken.length > 0;
}

/** Deletes the pending rows created before `cutoff`; their names (reconciliation). */
export async function takeAgedPendingPhotos(
  db: Db,
  cutoff: Date,
): Promise<string[]> {
  const taken = await db
    .delete(pendingPhoto)
    .where(lt(pendingPhoto.createdAt, cutoff))
    .returning({ fileName: pendingPhoto.fileName });
  return taken.map((row) => row.fileName);
}

/** Every pending row (reconciliation's plan). */
export function pendingPhotoRows(
  db: Db,
): Promise<{ fileName: string; createdAt: Date }[]> {
  return db
    .select({
      fileName: pendingPhoto.fileName,
      createdAt: pendingPhoto.createdAt,
    })
    .from(pendingPhoto);
}

/** Deletes one pending row, whoever it belongs to (reconciliation: its bytes are gone). */
export async function deletePendingPhotoRow(
  db: Db,
  fileName: string,
): Promise<void> {
  await db.delete(pendingPhoto).where(eq(pendingPhoto.fileName, fileName));
}
