import { and, desc, eq, ilike, lt, or, type SQL, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { CutoutStatus } from '../../cutout/state';
import type { Db, Queryable } from '../../db/client';
import { file, garment } from '../../db/schema';
import type { ImageRef } from '../files/image-url';
import { compareSizes } from './garment';
import type { GarmentFields } from './validation';

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

/** The values the filter modal offers, archived garments included. */
export interface FilterOptions {
  categories: string[];
  sizes: string[];
}

/**
 * The wardrobe's distinct categories (sorted) and sizes (in wearing order),
 * in one statement. There is no brand filter in the UI, so no brand list.
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
    })
    .from(garment)
    .where(eq(garment.ownerId, ownerId));
  return {
    categories: [...row.categories].sort(),
    sizes: [...row.sizes].sort(compareSizes),
  };
}

/** A garment's photo on its page: the cutout's state decides what shows. */
export interface GarmentPhoto extends ImageRef {
  cutoutStatus: CutoutStatus;
}

/** A garment as its page and its forms show it. */
export interface GarmentDetail extends GarmentFields {
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
