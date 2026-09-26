import { and, between, eq } from 'drizzle-orm';
import type { Db, Queryable } from '../../db/client';
import { outfit, outfitCalendar } from '../../db/schema';
import { imageUrl } from '../files/image-url';
import type { IsoDate } from './calendar-date';
import type { CalendarEntry } from './calendar-view';

/**
 * The calendar's reads and writes. Every one is scoped to the signed-in
 * owner: outfits and calendar entries are private whatever wardrobe shares
 * exist. An entry that is not the caller's is a miss, the same as one that
 * does not exist: the route answers 404 either way, so entry ids reveal
 * nothing about other users (WardrobeAccess, src/web/sharing/access.ts).
 */

export type EntryMiss = 'not-found';

/** The owner's entries from `first` to `last` (inclusive), by day then id. */
export async function findEntries(
  db: Db,
  ownerId: number,
  first: IsoDate,
  last: IsoDate,
): Promise<CalendarEntry[]> {
  // Served by outfit_calendar_owner_id_day_outfit_id_unique (owner_id, day).
  const rows = await db.query.outfitCalendar.findMany({
    columns: { id: true, day: true, wornAt: true },
    where: and(
      eq(outfitCalendar.ownerId, ownerId),
      between(outfitCalendar.day, first, last),
    ),
    orderBy: (entry, { asc }) => [asc(entry.day), asc(entry.id)],
    with: {
      outfit: {
        columns: { id: true, name: true },
        with: {
          // The outfit's garments in the order it was built (empty slots
          // have nothing to show).
          slots: {
            columns: {},
            where: (slot, { isNotNull }) => isNotNull(slot.garmentId),
            orderBy: (slot, { asc }) => [asc(slot.position)],
            with: {
              garment: {
                columns: {},
                with: { photo: { columns: { fileName: true, version: true } } },
              },
            },
          },
        },
      },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    day: row.day,
    worn: row.wornAt !== null,
    outfit: {
      id: row.outfit.id,
      name: row.outfit.name,
      photoUrls: row.outfit.slots.flatMap(({ garment }) =>
        garment?.photo ? [imageUrl(garment.photo, 'thumb')] : [],
      ),
    },
  }));
}

export type ScheduleOutcome = 'scheduled' | 'already-scheduled';

/** What insertEntry did; a new entry's id, for a caller that marks it worn (the seed). */
export type Scheduled =
  | { outcome: 'scheduled'; id: number }
  | { outcome: 'already-scheduled' };

/**
 * Plans the owner's outfit on `day`. Idempotent: planning the same outfit on
 * the same day again inserts nothing (the unique (owner, day, outfit)
 * constraint) and reports 'already-scheduled', so a double tap or a replayed
 * form is not an error.
 */
export async function scheduleOutfit(
  db: Db,
  entry: { ownerId: number; outfitId: number; day: IsoDate },
): Promise<ScheduleOutcome | 'no-such-outfit'> {
  const [owned] = await db
    .select({ id: outfit.id })
    .from(outfit)
    .where(
      and(eq(outfit.id, entry.outfitId), eq(outfit.ownerId, entry.ownerId)),
    );
  if (!owned) return 'no-such-outfit';
  return (await insertEntry(db, entry)).outcome;
}

/**
 * The one writer of calendar entries, for an outfit the caller has already
 * found to be the owner's: POST /calendar (scheduleOutfit), the outfit
 * form's "Add to calendar", inside its save transaction
 * (src/web/outfits/queries.ts), and the seed's simulated history. An entry
 * starts unworn: setEntryWorn (src/web/wears/queries.ts) is the only way to
 * mark one, because its wear rows change with it.
 */
export async function insertEntry(
  db: Queryable,
  entry: { ownerId: number; outfitId: number; day: IsoDate },
): Promise<Scheduled> {
  const [inserted] = await db
    .insert(outfitCalendar)
    .values(entry)
    .onConflictDoNothing({
      target: [
        outfitCalendar.ownerId,
        outfitCalendar.day,
        outfitCalendar.outfitId,
      ],
    })
    .returning({ id: outfitCalendar.id });
  return inserted
    ? { outcome: 'scheduled', id: inserted.id }
    : { outcome: 'already-scheduled' };
}

/** Deletes the owner's entry; its wears go with it (garment_wear's foreign key). */
export async function deleteEntry(
  db: Db,
  id: number,
  ownerId: number,
): Promise<'deleted' | EntryMiss> {
  const deleted = await db
    .delete(outfitCalendar)
    .where(and(eq(outfitCalendar.id, id), eq(outfitCalendar.ownerId, ownerId)))
    .returning({ id: outfitCalendar.id });
  return deleted.length > 0 ? 'deleted' : 'not-found';
}
