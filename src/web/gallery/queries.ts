import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { Db, Queryable } from '../../db/client';
import {
  file,
  garment,
  garmentWear,
  generatorAvoid,
  outfit,
  outfitSlot,
} from '../../db/schema';
import { washLimit } from '../../wardrobe/availability';
import type { IdeaGarment, SavedOutfit } from '../../wardrobe/generator';
import { categoryRole } from '../../wardrobe/properties';
import type { PlannerGarment } from '../../wardrobe/week-planner';
import { matchGarment } from '../../weather/match';
import type { IsoDate } from '../calendar/calendar-date';
import { inCapsule } from '../capsules/queries';
import type { ImageRef } from '../files/image-url';
import { inCloset, onWishlist, ownedGarment } from '../wardrobe/status';
import { availableGarment, wearsSinceWashSql } from '../wears/queries';

/**
 * The outfit gallery's rows (#9): the generator's pool and what it must
 * avoid, read per owner, and the one writer of generator_avoid. Private like
 * outfits: every function is scoped to the signed-in owner, and shares
 * never reach it.
 */

/** A garment as the generator draws it and the gallery shows it. */
export interface PoolGarment extends IdeaGarment {
  name: string | null;
  category: string;
  photo: ImageRef | null;
}

const poolColumns = (today: IsoDate) => ({
  id: garment.id,
  name: garment.name,
  category: garment.category,
  colors: garment.colors,
  pattern: garment.pattern,
  formality: garment.formality,
  warmth: garment.warmth,
  type: garment.type,
  fabricWeight: garment.fabricWeight,
  waterResistant: garment.waterResistant,
  photo: { fileName: file.fileName, version: file.version },
  // Days since the last day worn (wears count by day); null when never.
  idleDays: sql<
    number | null
  >`(select (${today}::date - max(${garmentWear.day}))::int from ${garmentWear} where ${garmentWear.garmentId} = ${garment.id})`,
});

function poolQuery(db: Queryable, today: IsoDate, where: SQL | undefined) {
  return db
    .select(poolColumns(today))
    .from(garment)
    .leftJoin(file, eq(file.id, garment.photoId))
    .where(where);
}

type PoolRow = Awaited<ReturnType<typeof poolQuery>>[number];

function poolGarment(row: PoolRow): PoolGarment {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    photo: row.photo,
    role: categoryRole(row.category),
    colors: row.colors ?? [],
    pattern: row.pattern,
    formality: row.formality,
    weather: matchGarment(row),
    idleDays: row.idleDays,
  };
}

async function selectPool(
  db: Db,
  today: IsoDate,
  where: SQL | undefined,
): Promise<PoolGarment[]> {
  return (await poolQuery(db, today, where)).map(poolGarment);
}

/**
 * What the generator may draw: the owner's garments that are available
 * (availableGarment: in the closet, not away, a clean copy left), within
 * the capsule when one is given. One statement; the last-worn day is a
 * correlated subquery per garment (the garment_wear (garment_id, day)
 * index).
 */
export function ideaPool(
  db: Db,
  ownerId: number,
  options: { today: IsoDate; capsuleId?: number },
): Promise<PoolGarment[]> {
  return selectPool(
    db,
    options.today,
    and(
      eq(garment.ownerId, ownerId),
      availableGarment(),
      options.capsuleId === undefined
        ? undefined
        : inCapsule(options.capsuleId),
    ),
  );
}

/** A garment as the week planner (#16) draws it: the pool's, with its wash state today. */
export type WeekPoolGarment = PoolGarment & PlannerGarment;

/**
 * The week planner's pool (src/wardrobe/week-planner.ts): the owner's
 * garments in the closet and not away, **dirty ones included**, each with
 * what the wash rule needs (quantity, washLimit, wears since the wash as
 * wearsSinceWashSql counts them). The planner applies availability.ts's
 * cleanCopies per day, counting the week's own future wears, so a garment
 * clean today may be out by Thursday; filtering by availableGarment here
 * would decide as of today only. One statement.
 */
export async function weekPool(
  db: Queryable,
  ownerId: number,
  today: IsoDate,
): Promise<WeekPoolGarment[]> {
  const rows = await db
    .select({
      ...poolColumns(today),
      quantity: garment.quantity,
      washAfterWears: garment.washAfterWears,
      wearsSinceWash: wearsSinceWashSql(),
    })
    .from(garment)
    .leftJoin(file, eq(file.id, garment.photoId))
    .where(and(eq(garment.ownerId, ownerId), inCloset(), isNull(garment.away)));
  return rows.map((row) => ({
    ...poolGarment(row),
    quantity: row.quantity,
    washLimit: washLimit(row.category, row.washAfterWears),
    wearsSinceWash: row.wearsSinceWash,
  }));
}

/**
 * Garments locked into every idea, whether or not they are clean (the
 * person chose them): `?with=`'s garment, Styling's locked rows (#42). The
 * owner's, in the closet; fewer than asked for any that is not (archived,
 * a wishlist item, someone else's, gone). A wishlist item is only ever
 * locked by "Goes with my closet" (wishlistGarments).
 */
export function styledGarments(
  db: Db,
  ownerId: number,
  garmentIds: readonly number[],
  today: IsoDate,
): Promise<PoolGarment[]> {
  if (garmentIds.length === 0) return Promise.resolve([]);
  return selectPool(
    db,
    today,
    and(
      inArray(garment.id, [...garmentIds]),
      eq(garment.ownerId, ownerId),
      inCloset(),
    ),
  );
}

/** `?with=`'s garment (styledGarments), or undefined. */
export async function styledGarment(
  db: Db,
  ownerId: number,
  garmentId: number,
  today: IsoDate,
): Promise<PoolGarment | undefined> {
  const [found] = await styledGarments(db, ownerId, [garmentId], today);
  return found;
}

/** A garment as "Goes with my closet" (#18b) reads it: the pool's, with its type (near-duplicates). */
export interface ClosetGarment extends PoolGarment {
  type: string | null;
}

/** A wishlist item as "Goes with my closet" locks it, and what it replaces. */
export interface WishlistGarment extends ClosetGarment {
  replacesGarmentId: number | null;
}

/**
 * The owner's whole closet (inCloset), dirty and away included, within a
 * capsule when given: "Goes with my closet" judges a purchase against what
 * the owner has, not against what is clean today, so the answer does not
 * move on laundry day; Styling's Shuffle over a shared wardrobe (#42,
 * browseIdea) draws from it because a grantee never learns the owner's
 * wash and away state. Never the owner's own gallery pool: ideas draw from
 * ideaPool. One statement.
 */
export async function closetGarments(
  db: Db,
  ownerId: number,
  today: IsoDate,
  capsuleId?: number,
): Promise<ClosetGarment[]> {
  const rows = await poolQuery(
    db,
    today,
    and(
      eq(garment.ownerId, ownerId),
      inCloset(),
      capsuleId === undefined ? undefined : inCapsule(capsuleId),
    ),
  );
  return rows.map((row) => ({ ...poolGarment(row), type: row.type }));
}

/**
 * The owner's wishlist items among `ids`, as the generator locks them. The
 * only read that hands a wishlist item to the generator: goesWithCloset and
 * goesWithCount (ideas.ts) lock it, and nothing adds it to a pool.
 */
export async function wishlistGarments(
  db: Db,
  ownerId: number,
  ids: readonly number[],
  today: IsoDate,
): Promise<WishlistGarment[]> {
  const rows = await db
    .select({
      ...poolColumns(today),
      replacesGarmentId: garment.replacesGarmentId,
    })
    .from(garment)
    .leftJoin(file, eq(file.id, garment.photoId))
    .where(
      and(
        eq(garment.ownerId, ownerId),
        inArray(garment.id, [...ids]),
        onWishlist(),
      ),
    );
  return rows.map((row) => ({
    ...poolGarment(row),
    type: row.type,
    replacesGarmentId: row.replacesGarmentId,
  }));
}

/**
 * The owner's saved outfits as the generator's duplicate rule reads them:
 * each outfit's chosen garments with their roles. One statement.
 */
export async function savedOutfits(
  db: Queryable,
  ownerId: number,
): Promise<SavedOutfit[]> {
  const rows = await db
    .select({
      outfitId: outfitSlot.outfitId,
      id: garment.id,
      category: garment.category,
    })
    .from(outfitSlot)
    .innerJoin(outfit, eq(outfit.id, outfitSlot.outfitId))
    .innerJoin(garment, eq(garment.id, outfitSlot.garmentId))
    .where(eq(outfit.ownerId, ownerId));
  const outfits = new Map<
    number,
    { id: number; role: IdeaGarment['role'] }[]
  >();
  for (const row of rows) {
    const slots = outfits.get(row.outfitId) ?? [];
    slots.push({ id: row.id, role: categoryRole(row.category) });
    outfits.set(row.outfitId, slots);
  }
  return [...outfits.values()];
}

/** The owner's avoided pairs, for the generator. */
export async function avoidedPairs(
  db: Queryable,
  ownerId: number,
): Promise<[number, number][]> {
  const rows = await db
    .select({ a: generatorAvoid.garmentAId, b: generatorAvoid.garmentBId })
    .from(generatorAvoid)
    .where(eq(generatorAvoid.ownerId, ownerId));
  return rows.map(({ a, b }) => [a, b]);
}

export type AvoidOutcome = 'added' | 'already' | 'not-found';

/**
 * "Clashes": the owner never wants `first` and `second` together again. The
 * one writer of generator_avoid rows. Both must be the owner's own garments
 * (owned now or once: an archived one may come back); anything else is
 * 'not-found' and writes nothing. Stored once, smaller id first, so asking
 * twice (either way round) is 'already'. Takes a Queryable: the seed writes
 * a persona's pairs inside its transaction.
 */
export function avoidPair(
  db: Queryable,
  ownerId: number,
  first: number,
  second: number,
): Promise<AvoidOutcome> {
  const [a, b] = first < second ? [first, second] : [second, first];
  if (a === b) return Promise.resolve('not-found');
  return db.transaction(async (tx) => {
    // FOR SHARE: a delete of either garment waits for this insert (or
    // cascades it away after), never leaving it to name a missing garment.
    const owned = await tx
      .select({ id: garment.id })
      .from(garment)
      .where(
        and(
          eq(garment.ownerId, ownerId),
          inArray(garment.id, [a, b]),
          ownedGarment(),
        ),
      )
      .orderBy(garment.id)
      .for('share');
    if (owned.length !== 2) return 'not-found';
    const inserted = await tx
      .insert(generatorAvoid)
      .values({ ownerId, garmentAId: a, garmentBId: b })
      .onConflictDoNothing()
      .returning({ ownerId: generatorAvoid.ownerId });
    return inserted.length > 0 ? 'added' : 'already';
  });
}

/** Undo from the garment page: the pair may be combined again. False when there was no such pair of the owner's. */
export async function allowPair(
  db: Db,
  ownerId: number,
  first: number,
  second: number,
): Promise<boolean> {
  const [a, b] = first < second ? [first, second] : [second, first];
  const deleted = await db
    .delete(generatorAvoid)
    .where(
      and(
        eq(generatorAvoid.ownerId, ownerId),
        eq(generatorAvoid.garmentAId, a),
        eq(generatorAvoid.garmentBId, b),
      ),
    )
    .returning({ ownerId: generatorAvoid.ownerId });
  return deleted.length > 0;
}

/** A garment the owner never pairs with another: the garment page's list. */
export interface AvoidedPartner {
  id: number;
  name: string | null;
  category: string;
}

/** The garments the owner said clash with `garmentId`, by name. */
export async function avoidedWith(
  db: Db,
  ownerId: number,
  garmentId: number,
): Promise<AvoidedPartner[]> {
  const partner = sql`case when ${generatorAvoid.garmentAId} = ${garmentId} then ${generatorAvoid.garmentBId} else ${generatorAvoid.garmentAId} end`;
  return db
    .select({ id: garment.id, name: garment.name, category: garment.category })
    .from(generatorAvoid)
    .innerJoin(garment, eq(garment.id, partner))
    .where(
      and(
        eq(generatorAvoid.ownerId, ownerId),
        or(
          eq(generatorAvoid.garmentAId, garmentId),
          eq(generatorAvoid.garmentBId, garmentId),
        ),
      ),
    )
    .orderBy(garment.name, garment.id);
}

/**
 * The owner's outfit whose chosen garments are exactly `garmentIds` (empty
 * slots aside), the oldest if several: what a pick of those garments is
 * already saved as. One statement over the owner's slots.
 */
export async function outfitOfGarments(
  db: Queryable,
  ownerId: number,
  garmentIds: readonly number[],
): Promise<{ id: number; name: string | null } | undefined> {
  const sorted = [...new Set(garmentIds)].sort((a, b) => a - b);
  const wanted = sql`array[${sql.join(
    sorted.map((id) => sql`${id}`),
    sql`, `,
  )}]::int[]`;
  const [found] = await db
    .select({ id: outfit.id, name: outfit.name })
    .from(outfit)
    .innerJoin(outfitSlot, eq(outfitSlot.outfitId, outfit.id))
    .where(and(eq(outfit.ownerId, ownerId), isNotNull(outfitSlot.garmentId)))
    .groupBy(outfit.id)
    .having(
      sql`array_agg(distinct ${outfitSlot.garmentId} order by ${outfitSlot.garmentId}) = ${wanted}`,
    )
    .orderBy(outfit.id)
    .limit(1);
  return found;
}

/**
 * A pick's garments: the owner's, in the closet, with what a slot and a
 * name need. Fewer rows than ids when any is not (a card from before the
 * garment was archived or deleted). Locked FOR SHARE until the pick
 * commits: an archive or a delete (setGarmentStatus, deleteGarment: FOR
 * UPDATE) waits for the outfit to be saved, and one that got there first
 * makes this wait and then leave the garment out (Postgres judges a
 * locked row again as that transaction committed it), so a pick never
 * saves an archived garment or a slot emptied by a delete (#122). In id
 * order, as bulkSetProperty locks them, so two such lockers cannot
 * deadlock.
 */
export async function pickedGarments(
  db: Queryable,
  ownerId: number,
  garmentIds: readonly number[],
): Promise<{ id: number; name: string | null; category: string }[]> {
  return db
    .select({ id: garment.id, name: garment.name, category: garment.category })
    .from(garment)
    .where(
      and(
        eq(garment.ownerId, ownerId),
        inArray(garment.id, [...garmentIds]),
        inCloset(),
      ),
    )
    .orderBy(garment.id)
    .for('share');
}
