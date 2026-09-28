import { type AnyColumn, inArray, type SQL, sql } from 'drizzle-orm';
import type { Db, Queryable } from '../../db/client';
import { garmentWear, outfitCalendar, user } from '../../db/schema';
import type { Occasion } from '../../wardrobe/occasions';
import { ownerTransaction } from '../auth/queries';
import type { IsoDate } from '../calendar/calendar-date';
import {
  type DayEntry,
  entriesOfDaySql,
  wearOutfitOn,
  type WornOutfit,
} from '../calendar/queries';
import { pickIdea, type PickResult } from '../gallery/ideas';

/**
 * Today's reads (#15) and its one write of its own, "Wear this". The
 * signed-in owner's own, like the calendar: shares never reach them.
 */

/**
 * Whether the owner marked anything worn on `day`: a calendar entry (its
 * worn pill, "Wore it", "Wear this") or a garment's "Wore today". The
 * evening reminder is skipped when so, and get_today answers it (todayFor's
 * `worn`, in Today's own statement). `ownerId` may be an outer query's
 * column (eveningDays).
 */
export function somethingWornSql(
  ownerId: number | AnyColumn,
  day: IsoDate,
): SQL<boolean> {
  // garment_wear_owner_id_index, then the day.
  return sql<boolean>`(exists (
      select 1 from ${outfitCalendar}
      where ${outfitCalendar.ownerId} = ${ownerId}
        and ${outfitCalendar.day} = ${day}
        and ${outfitCalendar.wornAt} is not null
    ) or exists (
      select 1 from ${garmentWear}
      where ${garmentWear.ownerId} = ${ownerId}
        and ${garmentWear.day} = ${day}
    ))`;
}

/**
 * A person's `day` as the evening reminder reads it (eveningDays). A type,
 * not an interface: execute's row type needs its implicit index signature.
 */
export type EveningDay = {
  /** somethingWornSql: the reminder is skipped. */
  worn: boolean;
  /** The day's entries, bare (entriesOfDaySql): what the reminder names. */
  entries: DayEntry[];
};

/**
 * Each of `ownerIds`' `day` as the evening reminder reads it, in one
 * statement whoever and however many they are (#173; it was a statement
 * per person, then Today's whole model, weather and ideas included, for
 * the planned outfits' names alone). A deleted account is simply absent.
 */
export async function eveningDays(
  db: Db,
  ownerIds: readonly number[],
  day: IsoDate,
): Promise<Map<number, EveningDay>> {
  if (ownerIds.length === 0) return new Map();
  const { rows } = await db.execute<{ ownerId: number } & EveningDay>(sql`
    select ${user.id} as "ownerId",
      ${somethingWornSql(user.id, day)} as worn,
      ${entriesOfDaySql(user.id, day)} as entries
    from ${user}
    where ${inArray(user.id, [...new Set(ownerIds)])}`);
  return new Map(rows.map(({ ownerId, ...evening }) => [ownerId, evening]));
}

export interface WoreIdea {
  outfit: PickResult;
  entryId: number;
  worn: WornOutfit['worn'];
}

/**
 * "Wear this" on one of Today's ideas: the idea becomes an outfit (pickIdea,
 * which reuses an outfit of exactly these garments), planned today for
 * `occasion` and marked worn (wearOutfitOn), in one owner transaction: a
 * failure in either leaves neither. The lock is taken once, here, so the
 * writers below join this transaction rather than each opening a savepoint
 * and locking again (ownerTransaction; #158: 25 statements became 10).
 * Idempotent: a double tap's second transaction waits on the owner lock,
 * finds the first's outfit and entry, and setEntryWorn finds it worn
 * already (`worn.changed` false). 'not-found' when a garment is not the
 * owner's or not in the closet (a card from before an archive), and nothing
 * is written.
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
  return ownerTransaction(db, ownerId, 'wearIdea', async (tx) => {
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
