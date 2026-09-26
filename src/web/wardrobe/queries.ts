import {
  and,
  arrayContains,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  lt,
  notInArray,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { CutoutStatus } from '../../cutout/state';
import type { Db, Queryable } from '../../db/client';
import { file, garment } from '../../db/schema';
import type { ImageRef } from '../files/image-url';
import { compareSizes } from './garment';
import {
  type Formality,
  GarmentCategory,
  type Material,
  propertyApplies,
  typesOf,
  type Warmth,
} from '../../wardrobe/properties';
import type {
  BulkChange,
  GarmentFields,
  GarmentPropertyFields,
} from './validation';

/**
 * Garments' reads and writes. Every query names the wardrobe (owner) it
 * reads or writes, as resolveWardrobeAccess (src/web/sharing/access.ts)
 * decided it: a garment outside that wardrobe is a miss like a missing one,
 * and the routes answer 404 either way. Reads return plain rows shaped for
 * the page, never whole entities.
 */

/** Tiles per grid page; the "load more" sentinel fetches the next one. */
export const GRID_PAGE_SIZE = 48;

/** The grid's filters, as the query string gives them (already validated). */
export interface GridFilters {
  keyword?: string;
  category?: string;
  color?: string;
  size?: string;
  /** A type of `category` (the route drops one that is not). */
  type?: string;
  warmth?: Warmth;
  formality?: Formality;
  /** Garments made (partly) of this material. */
  material?: Material;
  /** Include archived garments (the modal's "Show archived"). */
  archived: boolean;
}

/** A grid tile: what the card shows and links to. */
export interface GarmentTile {
  id: number;
  name: string | null;
  category: string;
  archived: boolean;
  photo: ImageRef | null;
}

export interface GridPage {
  tiles: GarmentTile[];
  /** The last tile's id when there are more: the next page is `id < before`. */
  before: number | undefined;
}

/** A LIKE pattern matching `text` anywhere, its own wildcards taken literally. */
export function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function gridWhere(ownerId: number, filters: GridFilters): SQL | undefined {
  const conditions: (SQL | undefined)[] = [eq(garment.ownerId, ownerId)];
  if (!filters.archived) conditions.push(eq(garment.archived, false));
  if (filters.category) {
    conditions.push(eq(garment.category, filters.category));
  }
  if (filters.size) conditions.push(eq(garment.size, filters.size));
  if (filters.type) conditions.push(eq(garment.type, filters.type));
  if (filters.warmth) conditions.push(eq(garment.warmth, filters.warmth));
  if (filters.formality) {
    conditions.push(eq(garment.formality, filters.formality));
  }
  if (filters.material) {
    conditions.push(arrayContains(garment.materials, [filters.material]));
  }
  if (filters.color) {
    // A whole item of the comma-joined list, never a substring of one.
    conditions.push(
      sql`(',' || ${garment.color} || ',') like ${containsPattern(`,${filters.color},`)}`,
    );
  }
  if (filters.keyword) {
    // Case-insensitive; the keyword's % and _ are matched as themselves
    // (Postgres' default LIKE escape is the backslash).
    const pattern = containsPattern(filters.keyword);
    conditions.push(
      or(
        ilike(garment.name, pattern),
        ilike(garment.notes, pattern),
        ilike(garment.brand, pattern),
      ),
    );
  }
  return and(...conditions);
}

/**
 * One page of the grid, newest first: `before` is the id the previous page
 * ended at (keyset, so a page costs the same however deep it is and a
 * garment added meanwhile never shifts one onto the next). One statement,
 * one row per tile, served by garment_owner_id_archived_id_index (or the
 * category one) in index order.
 */
export async function gridPage(
  db: Db,
  ownerId: number,
  filters: GridFilters,
  before?: number,
): Promise<GridPage> {
  const rows = await db
    .select({
      id: garment.id,
      name: garment.name,
      category: garment.category,
      archived: garment.archived,
      photo: { fileName: file.fileName, version: file.version },
    })
    .from(garment)
    .leftJoin(file, eq(file.id, garment.photoId))
    .where(
      and(
        gridWhere(ownerId, filters),
        before === undefined ? undefined : lt(garment.id, before),
      ),
    )
    .orderBy(desc(garment.id))
    .limit(GRID_PAGE_SIZE + 1);
  const tiles = rows.slice(0, GRID_PAGE_SIZE);
  return {
    tiles,
    before: rows.length > GRID_PAGE_SIZE ? tiles.at(-1)!.id : undefined,
  };
}

/** How many garments match the filters (the grid's result count). */
export function gridCount(
  db: Db,
  ownerId: number,
  filters: GridFilters,
): Promise<number> {
  return db.$count(garment, gridWhere(ownerId, filters));
}

/**
 * The values the filter modal offers: only what the wardrobe holds
 * (archived garments included), so no choice finds nothing.
 */
export interface FilterOptions {
  categories: string[];
  sizes: string[];
  types: string[];
  warmths: Warmth[];
  formalities: Formality[];
  materials: Material[];
}

/**
 * The wardrobe's distinct categories (sorted), sizes (in wearing order),
 * types, warmths, formalities and materials, in one statement (materials
 * through a subquery over their unnested arrays). There is no brand filter
 * in the UI, so no brand list.
 */
export async function filterOptions(
  db: Db,
  ownerId: number,
): Promise<FilterOptions> {
  const [row] = await db
    .select({
      categories: sql<
        string[]
      >`coalesce(array_agg(distinct ${garment.category}), '{}')`,
      sizes: sql<
        string[]
      >`coalesce(array_agg(distinct ${garment.size}) filter (where ${garment.size} is not null), '{}')`,
      types: sql<
        string[]
      >`coalesce(array_agg(distinct ${garment.type}) filter (where ${garment.type} is not null), '{}')`,
      warmths: sql<
        Warmth[]
      >`coalesce(array_agg(distinct ${garment.warmth}) filter (where ${garment.warmth} is not null), '{}')`,
      formalities: sql<
        Formality[]
      >`coalesce(array_agg(distinct ${garment.formality}) filter (where ${garment.formality} is not null), '{}')`,
      // Its own scan of the wardrobe, deliberately uncorrelated: unnesting
      // in the outer query would multiply its rows (harmless to the distinct
      // aggregates above, but a trap for anything added later).
      materials: sql<Material[]>`(
        select coalesce(array_agg(distinct worn.material), '{}')
        from garment owned cross join lateral unnest(owned.materials) as worn(material)
        where owned.owner_id = ${ownerId}
      )`,
    })
    .from(garment)
    .where(eq(garment.ownerId, ownerId));
  return {
    categories: [...row.categories].sort(),
    sizes: [...row.sizes].sort(compareSizes),
    types: row.types,
    warmths: [...row.warmths].sort(),
    formalities: [...row.formalities].sort(),
    materials: row.materials,
  };
}

/** A garment's photo on its page: the cutout's state decides what shows. */
export interface GarmentPhoto extends ImageRef {
  cutoutStatus: CutoutStatus;
}

/** A garment as its page and its forms show it, every property included. */
export interface GarmentDetail
  extends
    Omit<GarmentFields, keyof GarmentPropertyFields>,
    GarmentPropertyFields {
  id: number;
  shareableId: string;
  archived: boolean;
  photo: GarmentPhoto | null;
}

const detailColumns = {
  id: garment.id,
  shareableId: garment.shareableId,
  name: garment.name,
  category: garment.category,
  brand: garment.brand,
  color: garment.color,
  size: garment.size,
  notes: garment.notes,
  washingDetails: garment.washingDetails,
  acquiredOn: garment.acquiredOn,
  archived: garment.archived,
  type: garment.type,
  warmth: garment.warmth,
  formality: garment.formality,
  materials: garment.materials,
  pattern: garment.pattern,
  fit: garment.fit,
  sleeve: garment.sleeve,
  length: garment.length,
  fabricWeight: garment.fabricWeight,
  waterResistant: garment.waterResistant,
  photo: {
    fileName: file.fileName,
    version: file.version,
    cutoutStatus: file.cutoutStatus,
  },
};

/** The garment in `ownerId`'s wardrobe, or undefined. */
export async function findGarment(
  db: Db,
  id: number,
  ownerId: number,
): Promise<GarmentDetail | undefined> {
  const [row] = await db
    .select(detailColumns)
    .from(garment)
    .leftJoin(file, eq(file.id, garment.photoId))
    .where(and(eq(garment.id, id), eq(garment.ownerId, ownerId)));
  return row;
}

/**
 * The garment's photo inside a write transaction, the row locked so two
 * writes to one garment take turns. Undefined when the garment is not in
 * `ownerId`'s wardrobe (any more).
 */
export async function lockGarment(
  tx: Queryable,
  id: number,
  ownerId: number,
): Promise<{ photoId: number | null; fileName: string | null } | undefined> {
  const [row] = await tx
    .select({ photoId: garment.photoId, fileName: file.fileName })
    .from(garment)
    .leftJoin(file, eq(file.id, garment.photoId))
    .where(and(eq(garment.id, id), eq(garment.ownerId, ownerId)))
    .for('update', { of: garment });
  return row;
}

/** Inserts a garment into `ownerId`'s wardrobe; returns its id. */
export async function insertGarment(
  tx: Queryable,
  ownerId: number,
  fields: GarmentFields,
  photoId: number | null,
): Promise<number> {
  const [row] = await tx
    .insert(garment)
    .values({
      ...fields,
      // Share links address garments by this (the /share page).
      shareableId: randomUUID(),
      ownerId,
      photoId,
    })
    .returning({ id: garment.id });
  return row.id;
}

/** Writes every form field; false when the garment is not in `ownerId`'s wardrobe. */
export async function updateGarmentFields(
  db: Db,
  id: number,
  ownerId: number,
  fields: GarmentFields,
): Promise<boolean> {
  const updated = await db
    .update(garment)
    .set(fields)
    .where(and(eq(garment.id, id), eq(garment.ownerId, ownerId)))
    .returning({ id: garment.id });
  return updated.length > 0;
}

/** Points the (locked) garment at its new photo and drops the old photo's row. */
export async function replacePhotoRow(
  tx: Queryable,
  id: number,
  photoId: number,
  previousPhotoId: number | null,
): Promise<void> {
  await tx.update(garment).set({ photoId }).where(eq(garment.id, id));
  if (previousPhotoId !== null) {
    await tx.delete(file).where(eq(file.id, previousPhotoId));
  }
}

/**
 * Flips archived in one statement; the new value, or undefined when the
 * garment is not in `ownerId`'s wardrobe.
 */
export async function toggleArchived(
  db: Db,
  id: number,
  ownerId: number,
): Promise<boolean | undefined> {
  const [row] = await db
    .update(garment)
    .set({ archived: sql`not ${garment.archived}` })
    .where(and(eq(garment.id, id), eq(garment.ownerId, ownerId)))
    .returning({ archived: garment.archived });
  return row?.archived;
}

/**
 * Deletes the garment and its photo's row together; returns the photo's
 * stored name (for the caller to unlink after commit), null without one,
 * undefined when the garment is not in `ownerId`'s wardrobe. Outfit slots
 * that wore it are emptied by their foreign key.
 */
export function deleteGarment(
  db: Db,
  id: number,
  ownerId: number,
): Promise<string | null | undefined> {
  return db.transaction(async (tx) => {
    const locked = await lockGarment(tx, id, ownerId);
    if (!locked) return undefined;
    await tx.delete(garment).where(eq(garment.id, id));
    if (locked.photoId !== null) {
      await tx.delete(file).where(eq(file.id, locked.photoId));
    }
    return locked.fileName;
  });
}

/**
 * Sets one property on every listed garment of `ownerId`'s wardrobe whose
 * role has it (propertyApplies: a sleeve is never set on shoes), in one
 * transaction with the rows locked. Ids outside the wardrobe are ignored,
 * like an unknown id. Materials add one to each garment's set; every other
 * property is replaced (null clears it). Returns how many were set and how
 * many were skipped for their role.
 */
export function bulkSetProperty(
  db: Db,
  ownerId: number,
  ids: number[],
  change: BulkChange,
): Promise<{ updated: number; skipped: number }> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: garment.id, category: garment.category })
      .from(garment)
      .where(and(eq(garment.ownerId, ownerId), inArray(garment.id, ids)))
      .for('update');
    const applicable = rows
      .filter((row) => propertyApplies(change.property, row.category))
      .map((row) => row.id);
    if (applicable.length > 0) {
      await tx
        .update(garment)
        .set(bulkSet(change))
        .where(inArray(garment.id, applicable));
    }
    return {
      updated: applicable.length,
      skipped: rows.length - applicable.length,
    };
  });
}

function bulkSet(change: BulkChange) {
  switch (change.property) {
    case 'materials':
      // Added once: a garment that already has it keeps its set as is.
      return {
        materials: sql<Material[]>`case
          when ${garment.materials} @> array[${change.value}]::text[] then ${garment.materials}
          else coalesce(${garment.materials}, '{}') || array[${change.value}]::text[]
        end`,
      };
    case 'warmth':
      return { warmth: change.value };
    case 'formality':
      return { formality: change.value };
    case 'pattern':
      return { pattern: change.value };
    case 'fit':
      return { fit: change.value };
    case 'sleeve':
      return { sleeve: change.value };
    case 'length':
      return { length: change.value };
    case 'waterResistant':
      return { waterResistant: change.value };
  }
}

// The built-in categories with types, and those whose role has no warmth
// (bags): what "needs tags" asks of each (a custom category has warmth and
// formality but no types).
const BUILT_IN = Object.values(GarmentCategory);
const TYPED_CATEGORIES = BUILT_IN.filter((c) => typesOf(c).length > 0);
const NO_WARMTH = BUILT_IN.filter((c) => !propertyApplies('warmth', c));

/**
 * A garment still missing what the outfit generator and the weather will
 * read: its type (where its category has types), warmth (where its role
 * has one) or formality. Archived garments are left out.
 */
function needsTags(ownerId: number): SQL | undefined {
  return and(
    eq(garment.ownerId, ownerId),
    eq(garment.archived, false),
    or(
      isNull(garment.formality),
      and(isNull(garment.warmth), notInArray(garment.category, NO_WARMTH)),
      and(isNull(garment.type), inArray(garment.category, TYPED_CATEGORIES)),
    ),
  );
}

/** How many of `ownerId`'s garments still need tags (the wardrobe's prompt, the "left" count). */
export function countToTag(db: Db, ownerId: number): Promise<number> {
  return db.$count(garment, needsTags(ownerId));
}

/**
 * The next garment to tag, newest first, below `before` when given: the
 * tagging mode's cursor, so a skipped garment does not come back until the
 * next pass.
 */
export async function nextToTag(
  db: Db,
  ownerId: number,
  before?: number,
): Promise<GarmentDetail | undefined> {
  const [row] = await db
    .select(detailColumns)
    .from(garment)
    .leftJoin(file, eq(file.id, garment.photoId))
    .where(
      and(
        needsTags(ownerId),
        before === undefined ? undefined : lt(garment.id, before),
      ),
    )
    .orderBy(desc(garment.id))
    .limit(1);
  return row;
}

/** Writes the given properties; false when the garment is not in `ownerId`'s wardrobe. */
export async function updateGarmentProperties(
  db: Db,
  id: number,
  ownerId: number,
  fields: Partial<GarmentPropertyFields>,
): Promise<boolean> {
  const updated = await db
    .update(garment)
    .set(fields)
    .where(and(eq(garment.id, id), eq(garment.ownerId, ownerId)))
    .returning({ id: garment.id });
  return updated.length > 0;
}
