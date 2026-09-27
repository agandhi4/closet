import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { Db, Queryable } from '../../db/client';
import { garmentWear, outfitCalendar } from '../../db/schema';
import { compareOccasions, type Occasion } from '../../wardrobe/occasions';
import type { IsoDate } from '../calendar/calendar-date';
import { wearOutfitOn, type WornOutfit } from '../calendar/queries';
import { pickIdea, type PickResult } from '../gallery/ideas';
import type { CollageGarment } from '../outfits/collage';
import { SELFIE_WITH, type SelfieRef } from '../selfies/queries';

/**
 * Today's reads (#15) and its one write of its own, "Wear this". The
 * signed-in owner's own, like the calendar: shares never reach them.
 */

/** A calendar entry of today, with its outfit's garments for the collage. */
export interface TodayEntry {
  id: number;
  occasion: Occasion;
  worn: boolean;
  /** The outfit selfie taken for it (#19), if any. */
  selfie: SelfieRef | null;
  outfit: { id: number; name: string | null; garments: CollageGarment[] };
}

/**
 * The owner's entries on `day` in occasion order (then planned first), each
 * with its outfit's garments in slot order. One statement, served by the
 * unique (owner_id, day, outfit_id) index.
 */
export async function todayEntries(
  db: Db,
  ownerId: number,
  day: IsoDate,
): Promise<TodayEntry[]> {
  const rows = await db.query.outfitCalendar.findMany({
    columns: { id: true, occasion: true, wornAt: true },
    where: and(
      eq(outfitCalendar.ownerId, ownerId),
      eq(outfitCalendar.day, day),
    ),
    orderBy: (entry, { asc }) => [asc(entry.id)],
    with: {
      selfie: SELFIE_WITH,
      outfit: {
        columns: { id: true, name: true },
        with: {
          slots: {
            columns: {},
            where: (slot, { isNotNull }) => isNotNull(slot.garmentId),
            orderBy: (slot, { asc }) => [asc(slot.position)],
            with: {
              garment: {
                columns: { id: true, name: true, category: true },
                with: { photo: { columns: { fileName: true, version: true } } },
              },
            },
          },
        },
      },
    },
  });
  return rows
    .map((row) => ({
      id: row.id,
      occasion: row.occasion,
      worn: row.wornAt !== null,
      selfie: row.selfie,
      outfit: {
        id: row.outfit.id,
        name: row.outfit.name,
        garments: row.outfit.slots.flatMap(({ garment }) =>
          garment ? [garment] : [],
        ),
      },
    }))
    .sort((a, b) => compareOccasions(a.occasion, b.occasion));
}

/**
 * Whether the owner marked anything worn on `day`: a calendar entry (its
 * worn pill, "Wore it", "Wear this") or a garment's "Wore today". The
 * evening reminder is skipped when so.
 */
export async function somethingWornOn(
  db: Db,
  ownerId: number,
  day: IsoDate,
): Promise<boolean> {
  const entry = db
    .select({ one: sql`1` })
    .from(outfitCalendar)
    .where(
      and(
        eq(outfitCalendar.ownerId, ownerId),
        eq(outfitCalendar.day, day),
        isNotNull(outfitCalendar.wornAt),
      ),
    );
  // garment_wear_owner_id_index, then the day.
  const wear = db
    .select({ one: sql`1` })
    .from(garmentWear)
    .where(and(eq(garmentWear.ownerId, ownerId), eq(garmentWear.day, day)));
  const { rows } = await db.execute<{ worn: boolean }>(
    sql`select exists(${entry}) or exists(${wear}) as worn`,
  );
  return rows[0].worn;
}

export interface WoreIdea {
  outfit: PickResult;
  entryId: number;
  worn: WornOutfit['worn'];
}

/**
 * "Wear this" on one of Today's ideas: the idea becomes an outfit (pickIdea,
 * which reuses an outfit of exactly these garments), planned today for
 * `occasion` and marked worn (wearOutfitOn), in one transaction: a failure
 * in either leaves neither. Idempotent: pickIdea runs under lockOwner, so a
 * double tap's second transaction waits for the first, finds its outfit and
 * its entry, and setEntryWorn finds it worn already (`worn.changed` false).
 * 'not-found' when a garment is not the owner's or not in the closet (a card
 * from before an archive), and nothing is written.
 */
export function wearIdea(
  db: Queryable,
  ownerId: number,
  input: {
    garmentIds: readonly number[];
    occasion: Occasion;
    today: IsoDate;
    at: Date;
  },
): Promise<WoreIdea | 'not-found'> {
  const { today } = input;
  return db.transaction(async (tx) => {
    const outfit = await pickIdea(tx, ownerId, {
      garmentIds: input.garmentIds,
    });
    if (outfit === 'not-found') return 'not-found';
    const worn = await wearOutfitOn(tx, {
      ownerId,
      outfitId: outfit.id,
      day: today,
      occasion: input.occasion,
      at: input.at,
      today,
    });
    // Today is never after today.
    if (worn === 'future') throw new Error('Today is after today');
    return { outfit, entryId: worn.entryId, worn: worn.worn };
  });
}
