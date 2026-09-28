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
  ne,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Db, Queryable } from '../../db/client';
import { file, pendingPhoto } from '../../db/schema';
import { selectScalars } from '../../db/select-scalars';

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
 * both keep an eleventh unbatched photo or a thirty-first draft. What
 * each judges under it (the eviction, the drafts' count) is a statement
 * after the one that waited, so its snapshot sees what the other committed.
 */
function userPendingLock(userId: number): SQL {
  return sql`pg_advisory_xact_lock(hashtext(${`closet:pending-photos:${userId}`}))`;
}

async function lockUserPending(tx: Queryable, userId: number): Promise<void> {
  await tx.execute(sql`select ${userPendingLock(userId)}`);
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
    // The insert takes the user's lock as it returns (#161: a round trip
    // less than a statement of its own). Before the lock is enough for the
    // insert, which judges nothing; the eviction below is what the lock
    // orders, and it is the next statement.
    await tx
      .insert(pendingPhoto)
      .values({ fileName, userId })
      .returning({ locked: userPendingLock(userId) });
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

/** A draft of a batch still waiting (#200), as the queue lists it. */
export interface WaitingDraft {
  fileName: string;
  position: number;
}

/**
 * A draft: which batch, its place there, and the batch's drafts waiting,
 * in picked order (read with it, so the queue costs no statement of its
 * own: the form's, the save's next draft, the discard's).
 */
export interface Draft {
  batchId: string;
  position: number;
  waiting: WaitingDraft[];
}

/** The drafts of `batchId` still waiting, but `except`, in picked order: a JSON array. */
function waitingSql(
  userId: number,
  batchId: SQL | AnyPgColumn,
  except?: string,
): SQL<WaitingDraft[]> {
  const waiting = alias(pendingPhoto, 'waiting');
  return sql<WaitingDraft[]>`(
    select coalesce(
      json_agg(
        json_build_object(
          'fileName', ${waiting.fileName},
          'position', coalesce(${waiting.batchPosition}, 0)
        )
        order by ${waiting.batchPosition}
      ),
      '[]'
    )
    from ${pendingPhoto} as ${waiting}
    where ${and(
      eq(waiting.userId, userId),
      eq(waiting.batchId, batchId),
      except === undefined ? undefined : ne(waiting.fileName, except),
    )}
  )`;
}

/** The grid's drafts prompt (#200): how many wait, and where Continue opens. */
export interface DraftsWaiting {
  count: number;
  first: string;
}

/**
 * `userId`'s drafts waiting for `ownerId`'s wardrobe (the grid's prompt):
 * how many, and the first of the oldest batch, where Continue opens; null
 * for none. A scalar subquery, so the grid reads it in the statement that
 * reads its other counts (gridContext, src/web/wardrobe/grid-context.ts).
 * One row: the count is a window over the whole match, taken before the
 * limit.
 */
export function draftsWaitingSql(
  userId: number,
  ownerId: number,
): SQL<DraftsWaiting | null> {
  return sql<DraftsWaiting | null>`(
    select json_build_object('first', ${pendingPhoto.fileName}, 'count', count(*) over ())
    from ${pendingPhoto}
    where ${and(
      eq(pendingPhoto.userId, userId),
      eq(pendingPhoto.batchOwnerId, ownerId),
    )}
    order by ${sql.join(
      [
        asc(pendingPhoto.createdAt),
        asc(pendingPhoto.batchId),
        asc(pendingPhoto.batchPosition),
      ],
      sql`, `,
    )}
    limit 1
  )`;
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

/** A pending photo in scope as a lookup or a take finds it: a draft with its queue, or not a draft. */
export interface PendingPhoto {
  draft: Draft | undefined;
}

/** pendingPhotoSql's JSON: the row's batch and whether it is in scope. */
interface PendingPhotoJson {
  inScope: boolean;
  batchId: string | null;
  position: number | null;
  waiting: WaitingDraft[] | null;
}

function draftOf(row: Omit<PendingPhotoJson, 'inScope'>): Draft | undefined {
  const { batchId, position, waiting } = row;
  return batchId !== null && position !== null
    ? { batchId, position, waiting: waiting ?? [] }
    : undefined;
}

/**
 * Deletes the pending row of `fileName` when it is in `scope` and no
 * `file` row has the name, and answers what it was (a draft with the
 * batch's drafts still waiting after it went, #200); undefined when there
 * was none (someone else's, a draft of another wardrobe, claimed,
 * discarded, evicted or reconciled; with `draftsOnly`, not a draft).
 * Inside the claim's or the discard's transaction, after lockPhotoName:
 * the row lock orders it against any other taker, so exactly one wins,
 * and this statement's snapshot, taken after the name's lock, sees any
 * `file` row a claimant committed meanwhile. One statement (#161): the
 * `file` check, the delete and the batch left, whose subquery reads the
 * rows as they were before this delete, so it leaves the taken one out
 * by name.
 */
export async function takePendingPhoto(
  tx: Queryable,
  fileName: string,
  scope: PendingScope,
  { draftsOnly = false }: { draftsOnly?: boolean } = {},
): Promise<PendingPhoto | undefined> {
  const { rows } = await tx.execute<Omit<PendingPhotoJson, 'inScope'>>(sql`
    with taken as (
      delete from ${pendingPhoto}
      where ${and(
        inScope(fileName, scope),
        draftsOnly ? isNotNull(pendingPhoto.batchId) : undefined,
        sql`not exists (select 1 from ${file} where ${eq(file.fileName, fileName)})`,
      )}
      returning ${pendingPhoto.batchId} as batch_id, ${pendingPhoto.batchPosition} as batch_position
    )
    select
      batch_id as "batchId",
      batch_position as "position",
      case when batch_id is null then null
        else ${waitingSql(scope.userId, sql`taken.batch_id`, fileName)}
      end as "waiting"
    from taken
  `);
  const [row] = rows;
  return row && { draft: draftOf(row) };
}

/**
 * `fileName` as a pending photo of `scope`'s user, as a scalar subquery
 * (a JSON object, null for none) for readPendingPhoto: whether it is in
 * scope, and a draft's batch, place and queue. The new garment form reads
 * it with its other lists in one statement (formContext,
 * src/web/wardrobe/form-context.ts).
 */
export function pendingPhotoSql(
  fileName: string,
  scope: PendingScope,
): SQL<PendingPhotoJson | null> {
  return sql<PendingPhotoJson | null>`(
    select json_build_object(
      'inScope', ${addsTo(scope.ownerId)},
      'batchId', ${pendingPhoto.batchId},
      'position', ${pendingPhoto.batchPosition},
      'waiting', case when ${pendingPhoto.batchId} is null then null
        else ${waitingSql(scope.userId, pendingPhoto.batchId)} end
    )
    from ${pendingPhoto}
    where ${and(
      eq(pendingPhoto.fileName, fileName),
      eq(pendingPhoto.userId, scope.userId),
    )}
  )`;
}

/**
 * pendingPhotoSql's answer: the photo while it is still a pending photo in
 * scope, with its draft (its queue includes it) when it is one;
 * `otherWardrobe` when it is the user's draft for another wardrobe than
 * the one addressed (the routes' 404); undefined when it is not the user's
 * pending photo at all (claimed, discarded, evicted, reconciled). Only a
 * hint: the take (takePendingPhoto, the same scope) is the check that
 * counts.
 */
export function readPendingPhoto(
  row: PendingPhotoJson | null | undefined,
): PendingPhoto | 'otherWardrobe' | undefined {
  if (!row) return undefined;
  if (!row.inScope) return 'otherWardrobe';
  return { draft: draftOf(row) };
}

/**
 * pendingPhotoSql alone: why a take found nothing (the save's and the
 * discard's refusal: a draft of another wardrobe is their 404).
 */
export async function pendingPhotoOf(
  db: Queryable,
  fileName: string,
  scope: PendingScope,
): Promise<PendingPhoto | 'otherWardrobe' | undefined> {
  const { pending } = await selectScalars(db, {
    pending: pendingPhotoSql(fileName, scope),
  });
  return readPendingPhoto(pending);
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
