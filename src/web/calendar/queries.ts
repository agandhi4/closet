import { and, between, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { outfit, outfitCalendar } from '../../db/schema';
import { imageUrl } from '../../file/file-url/image-url';
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
          outfitGarments: {
            columns: {},
            orderBy: (pivot, { asc }) => [asc(pivot.garmentId)],
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
      photoUrls: row.outfit.outfitGarments.flatMap(({ garment }) =>
        garment.photo ? [imageUrl(garment.photo, 'thumb')] : [],
      ),
    },
  }));
}

/**
 * Plans the owner's outfit on `day`. Idempotent: planning the same outfit on
 * the same day again inserts nothing (the unique (owner, day, outfit)
 * constraint) and reports 'already-scheduled', so a double tap or a replayed
 * form is not an error. OutfitService.schedule is the outfit form's twin
 * until the outfits port.
 */
export async function scheduleOutfit(
  db: Db,
  entry: { ownerId: number; outfitId: number; day: IsoDate },
): Promise<'scheduled' | 'already-scheduled' | 'no-such-outfit'> {
  const [owned] = await db
    .select({ id: outfit.id })
    .from(outfit)
    .where(
      and(eq(outfit.id, entry.outfitId), eq(outfit.ownerId, entry.ownerId)),
    );
  if (!owned) return 'no-such-outfit';
  const inserted = await db
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
  return inserted.length > 0 ? 'scheduled' : 'already-scheduled';
}

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

/**
 * Marks the entry worn (now) or clears the mark, in one statement so two
 * quick taps cannot both read "not worn". Returns the new state.
 */
export async function toggleWorn(
  db: Db,
  id: number,
  ownerId: number,
): Promise<{ worn: boolean } | EntryMiss> {
  const [updated] = await db
    .update(outfitCalendar)
    .set({
      wornAt: sql`case when ${outfitCalendar.wornAt} is null then now() end`,
    })
    .where(and(eq(outfitCalendar.id, id), eq(outfitCalendar.ownerId, ownerId)))
    .returning({ wornAt: outfitCalendar.wornAt });
  return updated ? { worn: updated.wornAt !== null } : 'not-found';
}
