import { and, eq, inArray, type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { initialCutoutState } from '../../cutout/state';
import type { Db, Queryable } from '../../db/client';
import { file, selfie } from '../../db/schema';
import { ownerTransaction } from '../auth/queries';
import type { IsoDate } from '../../calendar-date';
import type { SelfiePhoto } from '../files/image-url';
import { insertPhotoRow, type NewPhotoRow } from '../files/queries';
import { type EntryWornOutcome, setEntryWorn } from '../wears/queries';

/**
 * Outfit selfies (#19; docs/plans/2026-09-26-wardrobe-features.md, section
 * 13): a mirror photo as the record of what was worn. The owner's own, like
 * the calendar: every function is scoped to the owner, and nothing reaches
 * them through a share. The one writer of the `selfie` table is here
 * (setEntrySelfie, deleteSelfie, deleteEntrySelfie); the bytes are Photos',
 * unlinked by the callers after commit (writes.ts, removeEntry).
 */

/** A selfie as a view draws it: its id (removal) and its photo (the URLs). */
export interface SelfieRef {
  id: number;
  photo: SelfiePhoto;
}

export type SelfieOutcome =
  | {
      selfieId: number;
      /** The entry's day. */
      day: IsoDate;
      /** The photo this one replaced, to unlink after commit; null for a first. */
      replaced: string | null;
      worn: Exclude<EntryWornOutcome, 'not-found' | 'future'>;
    }
  | 'not-found'
  | 'future';

/**
 * Makes `photo` the owner's calendar entry's selfie and marks the entry
 * worn (setEntryWorn, the one worn writer), in one transaction: taking the
 * photo is saying it was worn. `photo` is bytes already stored whose row is
 * inserted here, with no cutout (`unwanted`: a selfie keeps its background,
 * so nothing is queued); a selfie the entry had is replaced, its `file` row
 * deleted here and its name answered for the caller to unlink after commit
 * (CLAUDE.md Gotchas, the commit contract). setEntryWorn locks the entry
 * first, so two uploads for one entry take turns and the second replaces
 * the first. 'not-found' (not the owner's entry) and 'future' (a day after
 * `today`) write nothing; the caller deletes the stored bytes.
 *
 * An owner transaction itself, so setEntryWorn joins it: one lock, no
 * savepoint (#165: three round trips fewer than a plain transaction that
 * setEntryWorn nested a savepoint in and then read the day again).
 *
 * Used by POST /calendar/:id/selfie (attachSelfie, writes.ts) and the seed.
 */
export function setEntrySelfie(
  q: Queryable,
  input: {
    entryId: number;
    ownerId: number;
    photo: NewPhotoRow;
    at: Date;
    today: IsoDate;
  },
): Promise<SelfieOutcome> {
  const { entryId, ownerId } = input;
  return ownerTransaction(q, ownerId, 'setEntrySelfie', async (tx) => {
    const worn = await setEntryWorn(tx, {
      entryId,
      ownerId,
      worn: true,
      at: input.at,
      today: input.today,
    });
    if (worn === 'not-found' || worn === 'future') return worn;
    const { day } = worn;
    const [previous] = await tx
      .select({
        id: selfie.id,
        photoId: selfie.photoId,
        fileName: file.fileName,
      })
      .from(selfie)
      .innerJoin(file, eq(file.id, selfie.photoId))
      .where(eq(selfie.outfitCalendarId, entryId));
    const photoId = await insertPhotoRow(tx, {
      ...input.photo,
      ...initialCutoutState('unwanted'),
    });
    if (previous) {
      await tx
        .update(selfie)
        .set({ photoId, createdAt: input.at })
        .where(eq(selfie.id, previous.id));
      await tx.delete(file).where(eq(file.id, previous.photoId));
      return {
        selfieId: previous.id,
        day,
        replaced: previous.fileName,
        worn,
      };
    }
    const [created] = await tx
      .insert(selfie)
      .values({
        ownerId,
        day,
        outfitCalendarId: entryId,
        photoId,
        createdAt: input.at,
      })
      .returning({ id: selfie.id });
    return { selfieId: created.id, day, replaced: null, worn };
  });
}

/**
 * Removes the owner's selfie (an entry's, or a look kept after its outfit
 * was deleted): its `file` row, which takes the selfie row with it. The
 * entry stays worn: removing the photo is not unwearing the outfit. Answers
 * the photo's name for the caller to unlink after commit; undefined when
 * the selfie is not the owner's.
 */
export async function deleteSelfie(
  q: Queryable,
  selfieId: number,
  ownerId: number,
): Promise<string | undefined> {
  const [deleted] = await q
    .delete(file)
    .where(
      inArray(
        file.id,
        q
          .select({ id: selfie.photoId })
          .from(selfie)
          .where(and(eq(selfie.id, selfieId), eq(selfie.ownerId, ownerId))),
      ),
    )
    .returning({ fileName: file.fileName });
  return deleted?.fileName;
}

/**
 * Removes the owner's selfie of a calendar entry about to be deleted
 * (deleteEntry, in its transaction, before the entry: the foreign key would
 * otherwise keep it as a detached look, which is what deleting the outfit
 * wants and deleting the entry does not). Answers the photo names to unlink
 * after commit. Scoped to the owner itself, so deleteEntry need not look
 * the entry up first: another's entry has none of the owner's selfies.
 */
export async function deleteEntrySelfie(
  tx: Queryable,
  entryId: number,
  ownerId: number,
): Promise<string[]> {
  const deleted = await tx
    .delete(file)
    .where(
      inArray(
        file.id,
        tx
          .select({ id: selfie.photoId })
          .from(selfie)
          .where(
            and(
              eq(selfie.outfitCalendarId, entryId),
              eq(selfie.ownerId, ownerId),
            ),
          ),
      ),
    )
    .returning({ fileName: file.fileName });
  return deleted.map((row) => row.fileName);
}

/**
 * Keeps the selfie of an entry whose outfit is being replaced as a look on
 * its day (replaceEntryOutfit, src/web/calendar/replace.ts, in its
 * transaction): the photo shows the outfit that was on the entry, so it
 * must not go on to picture the new one, and it stays the record of that
 * day, as when the outfit is deleted. Answers the selfie's id, or
 * undefined when the entry had none. The caller has locked the owner's
 * entry.
 */
export async function detachEntrySelfie(
  tx: Queryable,
  entryId: number,
): Promise<number | undefined> {
  const [detached] = await tx
    .update(selfie)
    .set({ outfitCalendarId: null })
    .where(eq(selfie.outfitCalendarId, entryId))
    .returning({ id: selfie.id });
  return detached?.id;
}

/**
 * Whether `fileName` is a selfie of the owner's: the one question
 * GET /selfies/* asks before streaming it (anyone else's is a 404, like a
 * missing photo).
 */
export async function isOwnSelfie(
  db: Db,
  fileName: string,
  ownerId: number,
): Promise<boolean> {
  const [row] = await db
    .select({ id: selfie.id })
    .from(selfie)
    .innerJoin(file, eq(file.id, selfie.photoId))
    .where(and(eq(file.fileName, fileName), eq(selfie.ownerId, ownerId)))
    .limit(1);
  return row !== undefined;
}

/** A look kept on its own: the selfie of an entry whose outfit was deleted. */
export interface DetachedLook extends SelfieRef {
  day: IsoDate;
}

/**
 * The owner's looks without an entry from `first` to `last` (inclusive), by
 * day then when they were taken: the calendar shows them on their day. A
 * scalar subquery (a JSON list) for the week's one statement (weekContext,
 * src/web/calendar/week-context.ts). Served by selfie_owner_id_day_index.
 */
export function detachedLooksSql(
  ownerId: number,
  first: IsoDate,
  last: IsoDate,
): SQL<DetachedLook[]> {
  return sql<DetachedLook[]>`(
    select coalesce(json_agg(json_build_object(
      'id', ${selfie.id},
      'day', ${selfie.day},
      'photo', json_build_object('fileName', ${file.fileName}, 'version', ${file.version})
    ) order by ${selfie.day}, ${selfie.id}), '[]')
    from ${selfie} inner join ${file} on ${file.id} = ${selfie.photoId}
    where ${selfie.ownerId} = ${ownerId}
      and ${selfie.day} between ${first} and ${last}
      and ${selfie.outfitCalendarId} is null)`;
}

/**
 * The selfie of the calendar entry `entryId` names (a column of an
 * enclosing query over outfit_calendar), as JSON: a SelfieRef, or null
 * without one. The calendar week, Today and get_calendar read it inside
 * entriesSql (src/web/calendar/queries.ts).
 */
export function entrySelfieSql(entryId: AnyPgColumn): SQL<SelfieRef | null> {
  return sql<SelfieRef | null>`(
    select json_build_object(
      'id', ${selfie.id},
      'photo', json_build_object('fileName', ${file.fileName}, 'version', ${file.version})
    )
    from ${selfie} inner join ${file} on ${file.id} = ${selfie.photoId}
    where ${selfie.outfitCalendarId} = ${entryId})`;
}
