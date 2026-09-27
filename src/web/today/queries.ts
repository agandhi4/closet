import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { Db, Queryable } from '../../db/client';
import { garmentWear, outfitCalendar } from '../../db/schema';
import type { Occasion } from '../../wardrobe/occasions';
import type { IsoDate } from '../calendar/calendar-date';
import { wearOutfitOn, type WornOutfit } from '../calendar/queries';
import { pickIdea, type PickResult } from '../gallery/ideas';

/**
 * Today's reads (#15) and its one write of its own, "Wear this". The
 * signed-in owner's own, like the calendar: shares never reach them.
 */

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
