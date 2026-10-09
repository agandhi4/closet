import {
  and,
  type AnyColumn,
  eq,
  inArray,
  isNull,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { Db, Queryable } from '../../db/client';
import { selectScalars } from '../../db/select-scalars';
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
import type { IsoDate } from '../../calendar-date';
import { inCapsule } from '../capsules/queries';
import type { SignablePhotoRef } from '../files/image-url';
import { photoRefJson, readPhotoRef } from '../files/queries';
import { sameGarmentsOutfit } from '../outfits/queries';
import { outfitIsComplete } from '../outfits/references';
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
  photo: SignablePhotoRef | null;
}

/** What the generator judges a garment by, and what a card names. */
const garmentColumns = {
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
};

/** Days since the last day worn (wears count by day); null when never. */
function idleDaysSql(today: IsoDate): SQL<number | null> {
  return sql<
    number | null
  >`(select (${today}::date - max(${garmentWear.day}))::int from ${garmentWear} where ${garmentWear.garmentId} = ${garment.id})`;
}

/** A garment of poolJsonSql's JSON: garmentColumns, the card's photo and the rotation's input. */
export type PoolRow = Pick<
  typeof garment.$inferSelect,
  keyof typeof garmentColumns
> & {
  photo: SignablePhotoRef | null;
  idleDays: number | null;
};

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

/**
 * Garments `where` names as a scalar subquery: a JSON array of PoolRow
 * (and `extra`'s keys), read back with readPool. `today`
 * null reads no last-worn day (idleDays null): for a grantee, who never
 * learns the owner's wears.
 */
function poolJsonSql<Row extends PoolRow = PoolRow>(
  where: SQL | undefined,
  today: IsoDate | null,
  /** More keys per garment (weekPoolSql's wash state). */
  extra: Record<string, SQL | AnyColumn> = {},
): SQL<Row[]> {
  const fields = Object.entries({
    ...garmentColumns,
    idleDays: today === null ? sql`null` : idleDaysSql(today),
    ...extra,
  }).map(([key, column]) => sql`${sql.raw(`'${key}'`)}, ${column}`);
  return sql<Row[]>`(
    select coalesce(json_agg(json_build_object(
      ${sql.join(fields, sql`, `)}, 'photo', ${photoRefJson}
    )), '[]')
    from ${garment}
    left join ${file} on ${eq(file.id, garment.photoId)}
    where ${where}
  )`;
}

/**
 * What the generator may draw: the owner's garments that are available
 * (availableGarment: in the closet, not away, a clean copy left), within
 * the capsule when one is given, as a scalar subquery (poolJsonSql), so
 * ideasFor reads it in one statement with the rest of what the generator
 * needs (selectScalars, #168). The last-worn day is a correlated subquery
 * per garment (the garment_wear (garment_id, day) index).
 */
export function ideaPoolSql(
  ownerId: number,
  options: { today: IsoDate; capsuleId?: number },
): SQL<PoolRow[]> {
  return poolJsonSql(
    and(
      eq(garment.ownerId, ownerId),
      availableGarment(),
      options.capsuleId === undefined
        ? undefined
        : inCapsule(options.capsuleId),
    ),
    options.today,
  );
}

/** ideaPoolSql's value as the generator's garments. */
export function readPool(rows: readonly PoolRow[]): PoolGarment[] {
  return rows.map(poolGarment);
}

/** A garment as the week planner (#16) draws it: the pool's, with its wash state today. */
export type WeekPoolGarment = PoolGarment & PlannerGarment;

/** A row of weekPoolSql: the pool's, and the wash state. */
export interface WeekPoolRow extends PoolRow {
  quantity: number;
  washAfterWears: number | null;
  wearsSinceWash: number;
}

/**
 * The week planner's pool (src/wardrobe/week-planner.ts): the owner's
 * garments in the closet and not away, **dirty ones included**, each with
 * what the wash rule needs (quantity, washLimit, wears since the wash as
 * wearsSinceWashSql counts them). The planner applies availability.ts's
 * cleanCopies per day, counting the week's own future wears, so a garment
 * clean today may be out by Thursday; filtering by availableGarment here
 * would decide as of today only. A scalar subquery (poolJsonSql, read back
 * with readWeekPool), so "Plan my week" and the re-plan read it in one
 * statement with the generator's memory (#173).
 */
export function weekPoolSql(
  ownerId: number,
  today: IsoDate,
): SQL<WeekPoolRow[]> {
  return poolJsonSql<WeekPoolRow>(
    and(eq(garment.ownerId, ownerId), inCloset(), isNull(garment.away)),
    today,
    {
      quantity: garment.quantity,
      washAfterWears: garment.washAfterWears,
      wearsSinceWash: wearsSinceWashSql(),
    },
  );
}

/** weekPoolSql's value as the planner's garments. */
export function readWeekPool(rows: readonly WeekPoolRow[]): WeekPoolGarment[] {
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
 * locked by "Goes with my closet" (goesWithInputsSql). As a scalar
 * subquery (poolJsonSql), so Styling reads them in the statement that
 * reads the pool (#163); `today` null for a shared wardrobe's (no wears).
 */
export function styledGarmentsSql(
  ownerId: number,
  garmentIds: readonly number[],
  today: IsoDate | null,
): SQL<PoolRow[]> {
  return poolJsonSql(
    and(
      inArray(garment.id, [...garmentIds]),
      eq(garment.ownerId, ownerId),
      inCloset(),
    ),
    today,
  );
}

/** styledGarmentsSql alone, in one statement: the gallery's `?with=`. */
async function styledGarments(
  db: Db,
  ownerId: number,
  garmentIds: readonly number[],
  today: IsoDate,
): Promise<PoolGarment[]> {
  const { styled } = await selectScalars(db, {
    styled: styledGarmentsSql(ownerId, garmentIds, today),
  });
  return readPool(styled);
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

/**
 * A garment as "Goes with my closet" (#18b) reads it: the pool's, with its
 * type (near-duplicates), never rotated (no idle days: its readers draw
 * uniformly, and a grantee's Shuffle never learns the owner's wears).
 */
export interface ClosetGarment extends PoolGarment {
  type: string | null;
  idleDays: null;
}

/** A wishlist item as "Goes with my closet" locks it, and what it replaces. */
export interface WishlistGarment extends ClosetGarment {
  replacesGarmentId: number | null;
}

/** A pool garment without its rotation: garmentColumns and the photo. */
type DrawnRow = Omit<PoolRow, 'idleDays'>;

/**
 * A DrawnRow as JSON, an array in drawnGarment's order, so the
 * closet rides in one statement with the item and the pairs
 * (goesWithInputsSql) and carries no key per garment. Null photo fields
 * for a garment without one (the left join).
 */
export type DrawnJson = [
  id: DrawnRow['id'],
  name: DrawnRow['name'],
  category: DrawnRow['category'],
  colors: DrawnRow['colors'],
  pattern: DrawnRow['pattern'],
  formality: DrawnRow['formality'],
  warmth: DrawnRow['warmth'],
  type: DrawnRow['type'],
  fabricWeight: DrawnRow['fabricWeight'],
  waterResistant: DrawnRow['waterResistant'],
  fileName: string | null,
  version: number | null,
  variantKey: string | null,
];

const drawnJson = sql<DrawnJson>`json_build_array(
  ${garment.id}, ${garment.name}, ${garment.category}, ${garment.colors},
  ${garment.pattern}, ${garment.formality}, ${garment.warmth}, ${garment.type},
  ${garment.fabricWeight}, ${garment.waterResistant},
  ${file.fileName}, ${file.version}, ${file.variantKey}
)`;

/** A drawnJson array as a garment that is never rotated. */
function drawnGarment([
  id,
  name,
  category,
  colors,
  pattern,
  formality,
  warmth,
  type,
  fabricWeight,
  waterResistant,
  fileName,
  version,
  variantKey,
]: DrawnJson): ClosetGarment {
  const photo =
    fileName === null || version === null
      ? null
      : readPhotoRef({ fileName, version, variantKey });
  return {
    ...poolGarment({
      ...{ id, name, category, colors, pattern, formality, warmth, type },
      ...{ fabricWeight, waterResistant, photo, idleDays: null },
    }),
    type,
    idleDays: null,
  };
}

/**
 * The owner's whole closet (inCloset), dirty and away included, within a
 * capsule when given, as a scalar subquery: "Goes with my closet" judges a
 * purchase against what the owner has, not against what is clean today,
 * so the answer does not move on laundry day; Styling's Shuffle over a
 * shared wardrobe (#42, browseIdea; read with the rows in Styling's
 * statement, #163) draws from it because a grantee never learns the
 * owner's wash and away state. Never the owner's own gallery
 * pool: ideas draw from ideaPoolSql. Without the pool's last-worn
 * subquery: both readers draw uniformly, so it fed nothing (#167: one
 * garment_wear lookup per closet garment on every wishlist item's page).
 */
export function closetGarmentsSql(
  ownerId: number,
  capsuleId?: number,
): SQL<DrawnJson[]> {
  return sql<DrawnJson[]>`(
    select coalesce(json_agg(${drawnJson} order by ${garment.id}), '[]')
    from ${garment}
    left join ${file} on ${eq(file.id, garment.photoId)}
    where ${and(
      eq(garment.ownerId, ownerId),
      inCloset(),
      capsuleId === undefined ? undefined : inCapsule(capsuleId),
    )}
  )`;
}

/** closetGarmentsSql's value as garments: browseIdea's pool (ideas.ts). */
export function readCloset(rows: readonly DrawnJson[]): ClosetGarment[] {
  return rows.map(drawnGarment);
}

/**
 * The owner's wishlist item `itemId` as drawnJson and what it replaces, or
 * null when it is not one of their wishlist items.
 */
function wishlistGarmentSql(
  ownerId: number,
  itemId: number,
): SQL<[DrawnJson, number | null] | null> {
  return sql<[DrawnJson, number | null] | null>`(
    select json_build_array(${drawnJson}, ${garment.replacesGarmentId})
    from ${garment}
    left join ${file} on ${eq(file.id, garment.photoId)}
    where ${and(
      eq(garment.ownerId, ownerId),
      eq(garment.id, itemId),
      onWishlist(),
    )}
  )`;
}

/**
 * What "Goes with my closet" (#18b; goesWithCloset, goesWithCount in
 * ideas.ts) judges: the owner's wishlist item as the generator locks it
 * (undefined when `itemId` is not one), their whole closet and their
 * avoided pairs.
 */
export interface GoesWithInputs {
  item: WishlistGarment | undefined;
  closet: ClosetGarment[];
  avoid: [number, number][];
}

/** GoesWithInputs as goesWithInputsSql reads them (readGoesWithInputs). */
export interface GoesWithInputsJson {
  item: [DrawnJson, number | null] | null;
  closet: DrawnJson[];
  avoid: [number, number][];
}

/**
 * GoesWithInputs as one JSON value, for a page that reads them with its
 * other lists (garmentContext, src/web/wardrobe/garment-context.ts), and
 * for goesWithInputs. The only read that hands a wishlist item to the
 * generator: goesWithCloset and goesWithCount lock it, and nothing adds
 * it to a pool.
 */
export function goesWithInputsSql(
  ownerId: number,
  itemId: number,
): SQL<GoesWithInputsJson> {
  return sql<GoesWithInputsJson>`json_build_object(
    'item', ${wishlistGarmentSql(ownerId, itemId)},
    'closet', ${closetGarmentsSql(ownerId)},
    'avoid', ${avoidedPairsSql(ownerId)}
  )`;
}

export function readGoesWithInputs(json: GoesWithInputsJson): GoesWithInputs {
  return {
    item: json.item
      ? { ...drawnGarment(json.item[0]), replacesGarmentId: json.item[1] }
      : undefined,
    closet: json.closet.map(drawnGarment),
    avoid: json.avoid,
  };
}

/**
 * GoesWithInputs for many wishlist items at once: the owner's wishlist
 * garments `which` picks (a condition on garment), with one closet and one
 * avoid list for all of them. The Muse inbox's "Unlocks N" and a need's
 * options side by side (src/web/wishlist/inbox.ts) read it with their other
 * lists in one statement.
 */
export interface ManyGoesWithInputs {
  items: WishlistGarment[];
  closet: ClosetGarment[];
  avoid: [number, number][];
}

export interface ManyGoesWithInputsJson {
  items: [DrawnJson, number | null][];
  closet: DrawnJson[];
  avoid: [number, number][];
}

export function goesWithManyInputsSql(
  ownerId: number,
  which: SQL,
): SQL<ManyGoesWithInputsJson> {
  return sql<ManyGoesWithInputsJson>`json_build_object(
    'items', (
      select coalesce(
        json_agg(json_build_array(${drawnJson}, ${garment.replacesGarmentId}) order by ${garment.id}),
        '[]'
      )
      from ${garment}
      left join ${file} on ${eq(file.id, garment.photoId)}
      where ${and(eq(garment.ownerId, ownerId), onWishlist(), which)}
    ),
    'closet', ${closetGarmentsSql(ownerId)},
    'avoid', ${avoidedPairsSql(ownerId)}
  )`;
}

export function readManyGoesWithInputs(
  json: ManyGoesWithInputsJson,
): ManyGoesWithInputs {
  return {
    items: json.items.map(([drawn, replaces]) => ({
      ...drawnGarment(drawn),
      replacesGarmentId: replaces,
    })),
    closet: json.closet.map(drawnGarment),
    avoid: json.avoid,
  };
}

/** goesWithInputsSql alone, in one statement. */
export async function goesWithInputs(
  db: Queryable,
  ownerId: number,
  itemId: number,
): Promise<GoesWithInputs> {
  const { inputs } = await selectScalars(db, {
    inputs: goesWithInputsSql(ownerId, itemId),
  });
  return readGoesWithInputs(inputs);
}

/** What the generator must not repeat or pair, beside its pool. */
export interface GeneratorMemory {
  /** The owner's saved outfits, for the duplicate rule. */
  saved: SavedOutfit[];
  /** The owner's avoided pairs ("Clashes", generator_avoid). */
  avoid: [number, number][];
}

/** Each saved slot's outfit, garment and category (savedSlotsSql). */
type SavedSlot = [outfitId: number, garmentId: number, category: string];

/**
 * The owner's complete saved outfits' chosen garments, as a scalar
 * subquery (arrays, not objects: json_agg of rows would carry the column
 * names in every element). The duplicate rule's input; read with
 * readGeneratorMemory. An incomplete outfit (a piece not bought yet,
 * src/web/outfits/references.ts) is left out: the rule compares the drawn
 * roles only, so one whose piece to buy is a layer would otherwise keep
 * the closet garments it shares from ever being suggested together.
 * Muse's proposals count, declined ones too (#335): Ideas never offers a
 * set Muse proposed or the owner turned down, nor the week planner one it
 * would then plan unsaved (outfitMayBeHeld refuses a proposal).
 */
function savedSlotsSql(ownerId: number): SQL<SavedSlot[]> {
  return sql<SavedSlot[]>`(
    select coalesce(json_agg(json_build_array(${outfitSlot.outfitId}, ${garment.id}, ${garment.category})), '[]')
    from ${outfitSlot}
    inner join ${outfit} on ${eq(outfit.id, outfitSlot.outfitId)}
    inner join ${garment} on ${eq(garment.id, outfitSlot.garmentId)}
    where ${and(eq(outfit.ownerId, ownerId), outfitIsComplete(outfit.id))}
  )`;
}

/** The owner's avoided pairs ("Clashes"), as a scalar subquery. */
function avoidedPairsSql(ownerId: number): SQL<[number, number][]> {
  return sql<[number, number][]>`(
    select coalesce(json_agg(json_build_array(${generatorAvoid.garmentAId}, ${generatorAvoid.garmentBId})), '[]')
    from ${generatorAvoid}
    where ${eq(generatorAvoid.ownerId, ownerId)}
  )`;
}

/**
 * What the generator must not repeat or pair, as scalar subqueries for a
 * caller's selectScalars (ideasFor reads them with the pool, the weather
 * and the page's own reads, #168; the week planner with its pool, #173);
 * readGeneratorMemory reads them back. They were two statements beside the
 * pool on every ideas surface (#158: statements, not their size, are what a
 * page pays for over production's ~114 ms link).
 */
export function generatorMemorySql(ownerId: number) {
  return { saved: savedSlotsSql(ownerId), avoid: avoidedPairsSql(ownerId) };
}

export function readGeneratorMemory(row: {
  saved: SavedSlot[];
  avoid: [number, number][];
}): GeneratorMemory {
  const outfits = new Map<
    number,
    { id: number; role: IdeaGarment['role'] }[]
  >();
  for (const [outfitId, id, category] of row.saved) {
    const outfitSlots = outfits.get(outfitId) ?? [];
    outfitSlots.push({ id, role: categoryRole(category) });
    outfits.set(outfitId, outfitSlots);
  }
  return { saved: [...outfits.values()], avoid: row.avoid };
}

export type AvoidOutcome = 'added' | 'already' | 'not-found';

/**
 * "Clashes": the owner never wants `first` and `second` together again. The
 * one writer of generator_avoid rows. Both must be the owner's own garments
 * (owned now or once: an archived one may come back); anything else is
 * 'not-found' and writes nothing. Stored once, smaller id first, so asking
 * twice (either way round) is 'already'. Takes a Queryable: the seed writes
 * a persona's pairs inside its transaction.
 *
 * One statement (#168; it was a transaction of four: begin, the check, the
 * insert, commit): the check locks both garments FOR SHARE, in id order, and
 * the insert runs only when it found both, so a delete of either waits for
 * the pair (then cascades it away) and never leaves it naming a missing
 * garment. The outcome is read from what the statement saw.
 */
export async function avoidPair(
  db: Queryable,
  ownerId: number,
  first: number,
  second: number,
): Promise<AvoidOutcome> {
  const [a, b] = first < second ? [first, second] : [second, first];
  if (a === b) return 'not-found';
  const owned = db
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
  const { rows } = await db.execute<{ owned: number; added: number }>(sql`
    with owned as (${owned}),
    added as (
      insert into ${generatorAvoid} (owner_id, garment_a_id, garment_b_id)
      select ${ownerId}::int, ${a}::int, ${b}::int
      where (select count(*) from owned) = 2
      on conflict do nothing
      returning 1
    )
    select (select count(*) from owned)::int as owned,
      (select count(*) from added)::int as added`);
  const [{ owned: found, added }] = rows;
  if (found !== 2) return 'not-found';
  return added > 0 ? 'added' : 'already';
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

/**
 * The garments the owner said clash with `garmentId`, by name, as a scalar
 * subquery (a JSON array, empty for none): the garment page reads it with
 * its other lists in one statement (garmentContext,
 * src/web/wardrobe/garment-context.ts).
 */
export function avoidedWithSql(
  ownerId: number,
  garmentId: number,
): SQL<AvoidedPartner[]> {
  const partner = sql`case when ${generatorAvoid.garmentAId} = ${garmentId} then ${generatorAvoid.garmentBId} else ${generatorAvoid.garmentAId} end`;
  return sql<AvoidedPartner[]>`(
    select coalesce(
      json_agg(
        json_build_object(
          'id', ${garment.id},
          'name', ${garment.name},
          'category', ${garment.category}
        )
        order by ${garment.name}, ${garment.id}
      ),
      '[]'
    )
    from ${generatorAvoid}
    join ${garment} on ${eq(garment.id, partner)}
    where ${and(
      eq(generatorAvoid.ownerId, ownerId),
      or(
        eq(generatorAvoid.garmentAId, garmentId),
        eq(generatorAvoid.garmentBId, garmentId),
      ),
    )}
  )`;
}

/** A pick's garments, and the outfit they already are, if any. */
export interface PickedGarments {
  garments: { id: number; name: string | null; category: string }[];
  existing: { id: number; name: string | null; pending: boolean } | undefined;
}

/**
 * A pick's garments: the owner's, in the closet, with what a slot and a
 * name need. Fewer than ids when any is not (a card from before the
 * garment was archived or deleted). Locked FOR SHARE until the pick
 * commits: an archive or a delete (setGarmentStatus, deleteGarment: FOR
 * UPDATE) waits for the outfit to be saved, and one that got there first
 * makes this wait and then leave the garment out (Postgres judges a
 * locked row again as that transaction committed it), so a pick never
 * saves an archived garment or a slot emptied by a delete (#122). In id
 * order, as bulkSetProperty locks them, so two such lockers cannot
 * deadlock. With them, in the same statement (#168: a round trip less on
 * every pick), the outfit they already are (sameGarmentsOutfit, the one
 * definition createOutfit's insert also asks), joined to each row; only
 * the garments are locked (FOR SHARE OF garment).
 */
export async function pickedGarments(
  db: Queryable,
  ownerId: number,
  garmentIds: readonly number[],
): Promise<PickedGarments> {
  const existing = sameGarmentsOutfit(db, ownerId, garmentIds).as('existing');
  const rows = await db
    .select({
      id: garment.id,
      name: garment.name,
      category: garment.category,
      existingId: existing.id,
      existingName: existing.name,
      existingPending: existing.pending,
    })
    .from(garment)
    .leftJoin(existing, sql`true`)
    .where(
      and(
        eq(garment.ownerId, ownerId),
        inArray(garment.id, [...garmentIds]),
        inCloset(),
      ),
    )
    .orderBy(garment.id)
    .for('share', { of: garment });
  // The outfit is the same on every row; none when no garment was found.
  const [first] = rows;
  return {
    garments: rows.map(({ id, name, category }) => ({ id, name, category })),
    existing:
      first === undefined || first.existingId === null
        ? undefined
        : {
            id: first.existingId,
            name: first.existingName,
            pending: first.existingPending === true,
          },
  };
}
