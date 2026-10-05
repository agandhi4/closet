import { and, asc, eq, type SQL, sql } from 'drizzle-orm';
import type { Queryable } from '../../db/client';
import { isUniqueViolation } from '../../db/errors';
import { selectScalars } from '../../db/select-scalars';
import {
  BRAND_SIZE_UNIQUE,
  bodyMeasurements,
  brandSize,
} from '../../db/schema';
import { brandKey } from '../../wardrobe/brands';
import {
  DEFAULT_LENGTH_UNIT,
  type LengthUnit,
  type Measurement,
  type Measurements,
  NO_MEASUREMENTS,
} from '../../wardrobe/measurements';
import type { BrandSizeFields } from './validation';

/**
 * Sizes' reads and their one writer each (#24; plan section 16). The
 * signed-in user's own, like the style profile: every function takes the
 * user whose rows it reads or writes, and callers pass the session's (or a
 * token's) user, never a wardrobe's owner.
 */

/** Each measurement's column, read under the measurement's name. */
const COLUMNS = {
  height: bodyMeasurements.heightCm,
  neck: bodyMeasurements.neckCm,
  shoulders: bodyMeasurements.shouldersCm,
  chest: bodyMeasurements.chestCm,
  sleeve: bodyMeasurements.sleeveCm,
  waist: bodyMeasurements.waistCm,
  hips: bodyMeasurements.hipsCm,
  inseam: bodyMeasurements.inseamCm,
} as const satisfies Record<Measurement, unknown>;

/** Each measurement's property, for the writes. */
const KEYS = {
  height: 'heightCm',
  neck: 'neckCm',
  shoulders: 'shouldersCm',
  chest: 'chestCm',
  sleeve: 'sleeveCm',
  waist: 'waistCm',
  hips: 'hipsCm',
  inseam: 'inseamCm',
} as const satisfies Record<
  Measurement,
  keyof typeof bodyMeasurements.$inferInsert
>;

export interface BodyMeasurements {
  unit: LengthUnit;
  lengths: Measurements;
}

/** The user's measurements and unit; none set and the default unit when never saved. */
export async function findMeasurements(
  db: Queryable,
  userId: number,
): Promise<BodyMeasurements> {
  const [row] = await db
    .select({ unit: bodyMeasurements.unit, ...COLUMNS })
    .from(bodyMeasurements)
    .where(eq(bodyMeasurements.userId, userId));
  if (!row) return { unit: DEFAULT_LENGTH_UNIT, lengths: NO_MEASUREMENTS };
  const { unit, ...lengths } = row;
  return { unit, lengths };
}

function lengthColumns(lengths: Measurements) {
  return Object.fromEntries(
    Object.entries(KEYS).map(([m, key]) => [key, lengths[m as Measurement]]),
  ) as Record<(typeof KEYS)[Measurement], number | null>;
}

/** The one writer of the lengths: every measurement, a cleared one null. */
export async function saveMeasurements(
  db: Queryable,
  userId: number,
  lengths: Measurements,
): Promise<void> {
  const values = lengthColumns(lengths);
  await db
    .insert(bodyMeasurements)
    .values({ userId, ...values })
    .onConflictDoUpdate({
      target: bodyMeasurements.userId,
      set: { ...values, updatedAt: sql`now()` },
    });
}

/** The one writer of the unit: how the lengths are shown and typed. */
export async function setLengthUnit(
  db: Queryable,
  userId: number,
  unit: LengthUnit,
): Promise<void> {
  await db
    .insert(bodyMeasurements)
    .values({ userId, unit })
    .onConflictDoUpdate({
      target: bodyMeasurements.userId,
      set: { unit, updatedAt: sql`now()` },
    });
}

export interface BrandSize extends BrandSizeFields {
  id: number;
}

const BRAND_SIZE = {
  id: brandSize.id,
  brand: brandSize.brand,
  size: brandSize.size,
  note: brandSize.note,
};

/** The user's brand notes, by brand whatever the case. */
export function brandSizesOf(
  db: Queryable,
  userId: number,
): Promise<BrandSize[]> {
  // brand_size_user_id_brand_key_unique serves both the filter and the order.
  return db
    .select(BRAND_SIZE)
    .from(brandSize)
    .where(eq(brandSize.userId, userId))
    .orderBy(asc(brandSize.brandKey));
}

/**
 * brandSizesOf as a scalar subquery (a JSON array, empty for none), for a
 * page that reads it with its other lists in one statement (the Muse
 * inbox, src/web/wishlist/inbox.ts).
 */
export function brandSizesSql(userId: number): SQL<BrandSize[]> {
  return sql<BrandSize[]>`(
    select coalesce(
      json_agg(
        json_build_object(
          'id', ${brandSize.id},
          'brand', ${brandSize.brand},
          'size', ${brandSize.size},
          'note', ${brandSize.note}
        )
        order by ${brandSize.brandKey}
      ),
      '[]'
    )
    from ${brandSize}
    where ${eq(brandSize.userId, userId)}
  )`;
}

/**
 * One brand's note, however the brand is spelled (null for none), as a
 * scalar subquery: a wishlist item's page reads it with its other lists in
 * one statement (garmentContext, src/web/wardrobe/garment-context.ts).
 * Undefined for a blank brand, which has no note to read: selectScalars
 * leaves such a column out.
 */
export function brandSizeSql(
  userId: number,
  brand: string,
): SQL<BrandSize | null> | undefined {
  const key = brandKey(brand);
  if (!key) return undefined;
  return sql<BrandSize | null>`(
    select json_build_object(
      'id', ${brandSize.id},
      'brand', ${brandSize.brand},
      'size', ${brandSize.size},
      'note', ${brandSize.note}
    )
    from ${brandSize}
    where ${and(eq(brandSize.userId, userId), eq(brandSize.brandKey, key))}
  )`;
}

/** brandSizeSql alone; undefined for none or a blank brand. */
export async function brandSizeFor(
  db: Queryable,
  userId: number,
  brand: string,
): Promise<BrandSize | undefined> {
  const { note } = await selectScalars(db, {
    note: brandSizeSql(userId, brand),
  });
  return note ?? undefined;
}

/**
 * The user's notes by brandKey, for a page that shows several brands (the
 * wishlist): one read, then a lookup per item.
 */
export type BrandSizeLookup = (brand: string | null) => BrandSize | undefined;

export function brandSizeLookup(rows: readonly BrandSize[]): BrandSizeLookup {
  const byKey = new Map(rows.map((row) => [brandKey(row.brand), row]));
  return (brand) => (brand ? byKey.get(brandKey(brand)) : undefined);
}

type BrandTaken = 'brand-taken';

/**
 * The one writer of a new brand row: its id, or 'brand-taken' when the
 * user has the brand already, in any case. In a savepoint, so a caller's
 * transaction (the seed's) survives the refusal.
 */
export async function addBrandSize(
  db: Queryable,
  userId: number,
  fields: BrandSizeFields,
): Promise<number | BrandTaken> {
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(brandSize)
        .values({ userId, ...fields, brandKey: brandKey(fields.brand) })
        .returning({ id: brandSize.id });
      return row.id;
    });
  } catch (error) {
    if (isUniqueViolation(error, BRAND_SIZE_UNIQUE)) return 'brand-taken';
    throw error;
  }
}

/** Rewrites the user's row `id`: 'not-found' for anyone else's, 'brand-taken' for another row's brand. */
export async function updateBrandSize(
  db: Queryable,
  id: number,
  userId: number,
  fields: BrandSizeFields,
): Promise<'updated' | 'not-found' | BrandTaken> {
  try {
    const updated = await db
      .update(brandSize)
      .set({ ...fields, brandKey: brandKey(fields.brand) })
      .where(and(eq(brandSize.id, id), eq(brandSize.userId, userId)))
      .returning({ id: brandSize.id });
    return updated.length > 0 ? 'updated' : 'not-found';
  } catch (error) {
    if (isUniqueViolation(error, BRAND_SIZE_UNIQUE)) return 'brand-taken';
    throw error;
  }
}

/** Deletes the user's row `id`: the brand it named, or undefined for anyone else's. */
export async function deleteBrandSize(
  db: Queryable,
  id: number,
  userId: number,
): Promise<string | undefined> {
  const [row] = await db
    .delete(brandSize)
    .where(and(eq(brandSize.id, id), eq(brandSize.userId, userId)))
    .returning({ brand: brandSize.brand });
  return row?.brand;
}
