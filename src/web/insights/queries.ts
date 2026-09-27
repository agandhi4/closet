import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { file, garment, garmentWear } from '../../db/schema';
import {
  type InsightGarment,
  PAIR_MIN_DAYS,
  PAIRS_LIMIT,
  type PairRow,
  RECENT_DAYS,
  type UnwornDays,
  wardrobeInsights,
  type WardrobeInsights,
} from '../../wardrobe/insights';
import type { IsoDate } from '../calendar/calendar-date';
import { inCloset } from '../wardrobe/status';

/**
 * Insights' two statements (#17): the closet's garments with their wear
 * counts, and the pairs most worn together. The owner's own, like wears:
 * both are scoped to `ownerId` and read only garments in the closet
 * (inCloset). Wears count distinct days, never rows (a garment in two
 * entries on one day is one wear). `today` is the household's
 * (todayIn(APP_TIMEZONE)); every day count is taken against it here, in
 * Postgres' date arithmetic (date - date is whole days), so the pure
 * computation (src/wardrobe/insights.ts) does none.
 */

/** One row per garment in the owner's closet, newest first. */
export function insightGarments(
  db: Db,
  ownerId: number,
  today: IsoDate,
): Promise<InsightGarment[]> {
  const recentFrom = sql`${today}::date - ${RECENT_DAYS}::int`;
  return db
    .select({
      id: garment.id,
      name: garment.name,
      category: garment.category,
      brand: garment.brand,
      color: garment.color,
      quantity: garment.quantity,
      price: garment.price,
      condition: garment.condition,
      photo: { fileName: file.fileName, version: file.version },
      wearDays: sql<number>`count(distinct ${garmentWear.day})::int`,
      recentWearDays: sql<number>`(count(distinct ${garmentWear.day}) filter (where ${garmentWear.day} > ${recentFrom}))::int`,
      lastWorn: sql<IsoDate | null>`max(${garmentWear.day})::text`,
      daysSinceWorn: sql<
        number | null
      >`(${today}::date - max(${garmentWear.day}))`,
      daysOwned: sql<number | null>`(${today}::date - ${garment.acquiredOn})`,
    })
    .from(garment)
    .leftJoin(file, eq(file.id, garment.photoId))
    .leftJoin(garmentWear, eq(garmentWear.garmentId, garment.id))
    .where(and(eq(garment.ownerId, ownerId), inCloset()))
    .groupBy(garment.id, file.id)
    .orderBy(desc(garment.id));
}

/**
 * The pairs of closet garments worn on the most of the same days in the
 * last RECENT_DAYS (at least PAIR_MIN_DAYS), at most PAIRS_LIMIT, the
 * lower id first in each. Days, not entries: a pair counts once a day
 * whichever outfits held them (the shoes of the office outfit and the
 * dinner jacket that evening are worn together). Bounded by the window:
 * the self-join is over one year's (garment, day) pairs of one owner.
 */
export async function wornPairs(
  db: Db,
  ownerId: number,
  today: IsoDate,
): Promise<PairRow[]> {
  const result = await db.execute<{ a: number; b: number; days: number }>(sql`
    with worn as (
      select distinct ${garmentWear.garmentId} as garment_id, ${garmentWear.day} as day
      from ${garmentWear}
      join ${garment} on ${garment.id} = ${garmentWear.garmentId}
      where ${garmentWear.ownerId} = ${ownerId}
        and ${inCloset()}
        and ${garmentWear.day} > ${today}::date - ${RECENT_DAYS}::int
        and ${garmentWear.day} <= ${today}::date
    )
    select one.garment_id as a, other.garment_id as b, count(*)::int as days
    from worn one
    join worn other on other.day = one.day and other.garment_id > one.garment_id
    group by one.garment_id, other.garment_id
    having count(*) >= ${PAIR_MIN_DAYS}
    order by days desc, a, b
    limit ${PAIRS_LIMIT}`);
  return result.rows;
}

/** The owner's insights: both statements at once, then the computation. */
export async function readInsights(
  db: Db,
  ownerId: number,
  today: IsoDate,
  unwornDays: UnwornDays,
): Promise<WardrobeInsights> {
  const [garments, pairs] = await Promise.all([
    insightGarments(db, ownerId, today),
    wornPairs(db, ownerId, today),
  ]);
  return wardrobeInsights(garments, pairs, unwornDays);
}
