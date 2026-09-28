import { randomUUID } from 'node:crypto';
import {
  and,
  asc,
  count,
  desc,
  eq,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from 'drizzle-orm';
import type { Db, Queryable } from '../../db/client';
import { pendingPhoto } from '../../db/schema';

/**
 * Pending photos: bytes stored before the garment form that will own them
 * is saved, and the `pending_photo` row that explains them. Three sources
 * store them (src/web/wardrobe/writes.ts): link import's fetched photo
 * (issue #6) and the add sheet's camera or one-photo library upload (#97),
 * kept one at a time by keepPendingPhoto; and a library pick of several,
 * kept together as a batch of drafts by recordDraftBatch (#200). The row
 * names the user who stored the photo; only that user may claim it (the
 * save, src/web/wardrobe/writes.ts) or discard it (another pick).
 * Reconciliation removes the ones left a day, drafts a week
 * (pendingCutoffs; src/maintenance/reconcile.ts), counted apart from its
 * deletion guard:
 * an abandoned import is routine, not the database and the disk
 * disagreeing. Account deletion removes a user's with their photos.
 *
 * Nothing here touches bytes: the callers delete a returned name's
 * variants through Photos, after their transaction commits.
 */

/**
 * Unbatched pending photos one user may hold; storing another evicts the
 * oldest. Batched drafts are not counted here and never evicted.
 */
export const MAX_PENDING_PER_USER = 10;

/**
 * Batched drafts one user may hold (#200): two batches of 15. An upload
 * that would pass it is refused whole (recordDraftBatch), never evicting a
 * draft, so a batch loses nothing it was not told about.
 */
export const MAX_DRAFTS_PER_USER = 30;

/**
 * How long a batch's drafts wait before reconciliation removes them: a
 * week (the owner, 2026-09-28), where a single pending photo waits a day
 * (reconciliation's own cutoff). A batch of 30 takes more than an evening
 * to work through; a single upload or link import is one form's worth.
 */
export const DRAFT_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The instants before which reconciliation removes pending rows: `single`
 * is its own cutoff (a day by default), and a draft's is a week before
 * `now`, or `single` when an operator's run reaches further back.
 */
export interface PendingCutoffs {
  single: Date;
  draft: Date;
}

export function pendingCutoffs(single: Date, now: number): PendingCutoffs {
  return {
    single,
    draft: new Date(Math.min(single.getTime(), now - DRAFT_LIFETIME_MS)),
  };
}

/** Whether a pending row is past its cutoff: the one rule, SQL and dry run alike. */
export function isAgedPending(
  row: { createdAt: Date; batchId: string | null },
  cutoffs: PendingCutoffs,
): boolean {
  return (
    row.createdAt < (row.batchId === null ? cutoffs.single : cutoffs.draft)
  );
}

/**
 * Serializes one user's pending-photo writes: two uploads at once cannot
 * both keep an eleventh unbatched photo or a thirty-first draft.
 */
async function lockUserPending(tx: Queryable, userId: number): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`closet:pending-photos:${userId}`}))`,
  );
}

/**
 * Records `fileName` (just stored) as `userId`'s pending photo and returns
 * the names evicted to keep their unbatched ones within
 * MAX_PENDING_PER_USER, oldest first: their rows are gone, and the caller
 * deletes their bytes. Drafts of a batch are never evicted.
 */
export function recordPendingPhoto(
  db: Db,
  fileName: string,
  userId: number,
): Promise<string[]> {
  return db.transaction(async (tx) => {
    await lockUserPending(tx, userId);
    await tx.insert(pendingPhoto).values({ fileName, userId });
    const unbatched = and(
      eq(pendingPhoto.userId, userId),
      isNull(pendingPhoto.batchId),
    );
    const kept = tx
      .select({ fileName: pendingPhoto.fileName })
      .from(pendingPhoto)
      .where(unbatched)
      .orderBy(desc(pendingPhoto.createdAt), desc(pendingPhoto.fileName))
      .limit(MAX_PENDING_PER_USER);
    const evicted = await tx
      .delete(pendingPhoto)
      .where(and(unbatched, sql`${pendingPhoto.fileName} not in ${kept}`))
      .returning({ fileName: pendingPhoto.fileName });
    return evicted.map((row) => row.fileName);
  });
}

/** The drafts `userId` holds, in every batch (the upload's room left). */
export async function draftsHeld(
  db: Queryable,
  userId: number,
): Promise<number> {
  const [row] = await db
    .select({ held: count() })
    .from(pendingPhoto)
    .where(
      and(eq(pendingPhoto.userId, userId), isNotNull(pendingPhoto.batchId)),
    );
  return row?.held ?? 0;
}

/**
 * Records `fileNames` (just stored, in the order picked) as one batch of
 * `userId`'s drafts for `ownerId`'s wardrobe: its id, or `refused` with the
 * drafts they already hold when the batch would take them past
 * MAX_DRAFTS_PER_USER. Nothing is written then; the caller deletes the
 * bytes and says so.
 */
export function recordDraftBatch(
  db: Db,
  fileNames: readonly string[],
  userId: number,
  ownerId: number,
): Promise<{ batchId: string } | { refused: { held: number } }> {
  return db.transaction(async (tx) => {
    await lockUserPending(tx, userId);
    const held = await draftsHeld(tx, userId);
    if (held + fileNames.length > MAX_DRAFTS_PER_USER) {
      return { refused: { held } };
    }
    const batchId = randomUUID();
    await tx.insert(pendingPhoto).values(
      fileNames.map((fileName, position) => ({
        fileName,
        userId,
        batchId,
        batchPosition: position,
        batchOwnerId: ownerId,
      })),
    );
    return { batchId };
  });
}

/** A draft: which batch, and its place there. */
export interface Draft {
  batchId: string;
  position: number;
}

/** The drafts of `batchId` still waiting, in the order they were picked. */
export async function batchDrafts(
  db: Queryable,
  userId: number,
  batchId: string,
): Promise<{ fileName: string; position: number }[]> {
  const rows = await db
    .select({
      fileName: pendingPhoto.fileName,
      position: pendingPhoto.batchPosition,
    })
    .from(pendingPhoto)
    .where(
      and(eq(pendingPhoto.userId, userId), eq(pendingPhoto.batchId, batchId)),
    )
    .orderBy(asc(pendingPhoto.batchPosition));
  return rows.map((row) => ({
    fileName: row.fileName,
    position: row.position ?? 0,
  }));
}

/**
 * `userId`'s drafts waiting for `ownerId`'s wardrobe (the grid's prompt):
 * how many, and the first of the oldest batch, where Continue opens. One
 * row: the count is a window over the whole match, taken before the limit.
 */
export async function draftsWaiting(
  db: Queryable,
  userId: number,
  ownerId: number,
): Promise<{ count: number; first: string } | undefined> {
  const [row] = await db
    .select({
      first: pendingPhoto.fileName,
      count: sql<number>`count(*) over ()`.mapWith(Number),
    })
    .from(pendingPhoto)
    .where(
      and(
        eq(pendingPhoto.userId, userId),
        eq(pendingPhoto.batchOwnerId, ownerId),
      ),
    )
    .orderBy(
      asc(pendingPhoto.createdAt),
      asc(pendingPhoto.batchId),
      asc(pendingPhoto.batchPosition),
    )
    .limit(1);
  return row;
}

/**
 * Who may take a pending photo, and where: the user who stored it, adding
 * to the wardrobe the request addresses (`ownerId`, the resolved
 * `access.ownerId`). An unbatched photo goes wherever its user adds; a
 * draft only to the wardrobe its batch was uploaded for (`batch_owner_id`),
 * so a grantee with MANAGE on two wardrobes cannot save one wardrobe's
 * draft into the other, nor discard it from there (#200). A draft whose
 * wardrobe is gone (null) matches nowhere and waits for reconciliation.
 */
export interface PendingScope {
  userId: number;
  ownerId: number;
}

/** The wardrobe half of the scope: unbatched, or a draft of `ownerId`'s. */
function addsTo(ownerId: number) {
  return or(
    isNull(pendingPhoto.batchId),
    eq(pendingPhoto.batchOwnerId, ownerId),
  );
}

function inScope(fileName: string, { userId, ownerId }: PendingScope) {
  return and(
    eq(pendingPhoto.fileName, fileName),
    eq(pendingPhoto.userId, userId),
    addsTo(ownerId),
  );
}

/**
 * Deletes the pending row of `fileName` when it is in `scope`; false when
 * there is none (someone else's, a draft of another wardrobe, claimed,
 * discarded, evicted or reconciled). Inside the claim's or the discard's
 * transaction: the row lock orders it against any other taker, so exactly
 * one wins.
 */
export async function takePendingPhoto(
  tx: Queryable,
  fileName: string,
  scope: PendingScope,
): Promise<boolean> {
  const taken = await tx
    .delete(pendingPhoto)
    .where(inScope(fileName, scope))
    .returning({ fileName: pendingPhoto.fileName });
  return taken.length > 0;
}

/**
 * `fileName` while it is still a pending photo in `scope`, with its batch
 * and place when it is a draft (#200); `otherWardrobe` when it is the
 * user's draft for another wardrobe than the one addressed (the routes'
 * 404); undefined when it is not the user's pending photo at all (claimed,
 * discarded, evicted, reconciled). The new garment form started from an
 * upload shows the photo only when it is in scope (GET
 * /wardrobe/new?photo=), and a save reads the batch before its claim to
 * know where the queue goes next. Only a hint: the claim
 * (takePendingPhoto, the same scope) is the check that counts.
 */
export async function pendingPhotoOf(
  db: Queryable,
  fileName: string,
  scope: PendingScope,
): Promise<{ draft: Draft | undefined } | 'otherWardrobe' | undefined> {
  const [row] = await db
    .select({
      batchId: pendingPhoto.batchId,
      position: pendingPhoto.batchPosition,
      inScope: sql<boolean>`${addsTo(scope.ownerId)}`,
    })
    .from(pendingPhoto)
    .where(
      and(
        eq(pendingPhoto.fileName, fileName),
        eq(pendingPhoto.userId, scope.userId),
      ),
    );
  if (!row) return undefined;
  if (!row.inScope) return 'otherWardrobe';
  const { batchId, position } = row;
  return {
    draft:
      batchId !== null && position !== null ? { batchId, position } : undefined,
  };
}

/**
 * Deletes the pending rows past their cutoff (isAgedPending: unbatched
 * ones before `single`, drafts before `draft`); their names
 * (reconciliation).
 */
export async function takeAgedPendingPhotos(
  db: Db,
  cutoffs: PendingCutoffs,
): Promise<string[]> {
  const taken = await db
    .delete(pendingPhoto)
    .where(
      or(
        and(
          isNull(pendingPhoto.batchId),
          lt(pendingPhoto.createdAt, cutoffs.single),
        ),
        and(
          isNotNull(pendingPhoto.batchId),
          lt(pendingPhoto.createdAt, cutoffs.draft),
        ),
      ),
    )
    .returning({ fileName: pendingPhoto.fileName });
  return taken.map((row) => row.fileName);
}

/** Every pending row (reconciliation's plan). */
export function pendingPhotoRows(
  db: Db,
): Promise<{ fileName: string; createdAt: Date; batchId: string | null }[]> {
  return db
    .select({
      fileName: pendingPhoto.fileName,
      createdAt: pendingPhoto.createdAt,
      batchId: pendingPhoto.batchId,
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
