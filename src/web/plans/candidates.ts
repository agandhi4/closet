import { and, asc, desc, eq, inArray, type SQL } from 'drizzle-orm';
import type { Queryable } from '../../db/client';
import {
  file,
  garment,
  planItem,
  planItemCandidate,
  wardrobePlan,
} from '../../db/schema';
import type { PieceSpec } from '../../wardrobe/plans';
import {
  type Formality,
  type GarmentColor,
  type Material,
  type Warmth,
} from '../../wardrobe/properties';
import { ownerTransaction } from '../auth/queries';
import { HttpError } from '../errors';
import type { ImageRef } from '../files/image-url';
import { t } from '../i18n';
import { onWishlist } from '../wardrobe/status';

/**
 * Candidate products for plan items (#34, slice 34b): wishlist garments the
 * owner is considering to fill a gap, which the shopping list shows under
 * each item. Stored in plan_item_candidate (src/db/schema.ts), a link, not a
 * column on the garment: a product can be the candidate of the same item in
 * two plans (a duplicate keeps them), and the wishlist is shared with MANAGE
 * grantees while plans are not, so nothing about a plan sits on a row a
 * grantee reads or edits.
 *
 * Private like plans: every read and write names the signed-in owner, and
 * a pair counts only when the item's plan and the garment are both theirs.
 * A candidate is read only while it is on the wishlist (onWishlist): once
 * "Bought it" moves it into the closet its link stops mattering, and the
 * closet side is matchPlan's, derived, never this table.
 */

/** Every pairing of these items with these garments. */
export interface CandidateSet {
  itemIds: number[];
  garmentIds: number[];
}

export interface CandidateChange {
  add?: CandidateSet;
  remove?: CandidateSet;
}

/**
 * Candidates a plan item holds at most: a curated few to choose between in
 * the store, not a catalogue. It also bounds what each candidate costs the
 * shopping list ("Goes with my closet"'s count, #18b). Counted over the
 * candidates still on the wishlist (the ones any page shows); applies to
 * new links only: an item already past it (none could be when it came in)
 * keeps its candidates and may drop some, just not gain one.
 */
export const MAX_CANDIDATES_PER_ITEM = 5;

/**
 * A change that would take an item past MAX_CANDIDATES_PER_ITEM: nothing
 * was written. A 400 with the reason, which the pickers re-render in their
 * form and add_candidate (MCP) answers as its error; thrown so that a
 * caller's transaction (the garment the link was made for) rolls back too.
 */
export class TooManyCandidates extends HttpError {
  constructor(readonly itemIds: number[]) {
    super(
      400,
      t('shopping.TOO_MANY_CANDIDATES', { max: MAX_CANDIDATES_PER_ITEM }),
    );
    this.name = 'TooManyCandidates';
  }
}

/**
 * The one writer of plan_item_candidate: removes every pairing in `remove`,
 * then adds every pairing in `add` (one already there is kept), in one
 * transaction. Only items of `ownerId`'s plans and garments of their
 * wardrobe take part, and only wishlist garments are added (a candidate is
 * something not owned yet); any other id is dropped. An add that would take
 * an item past MAX_CANDIDATES_PER_ITEM throws TooManyCandidates before
 * anything is written, counted under lockOwner (the owner's user row), so
 * two adds at once (two tabs, an agent beside the app) cannot both pass the
 * count. Both sides are locked FOR SHARE, so an item or garment deleted
 * meanwhile waits for this to commit rather than failing a foreign key
 * halfway. The item's candidates page, the wishlist item's "For plan
 * item…", the garment form's `planItem`, add_candidate (MCP), a plan's
 * duplicate and the seed all go through it. A savepoint inside a caller's
 * transaction.
 */
export function changeCandidates(
  db: Queryable,
  ownerId: number,
  change: CandidateChange,
): Promise<{ added: number; removed: number }> {
  // The owner lock first, before the rows below: the cap's count must see
  // every other change of this owner's candidates committed.
  return ownerTransaction(db, ownerId, async (tx) => {
    const sets = [change.add, change.remove].flatMap((set) => set ?? []);
    const items = await ownedItems(
      tx,
      ownerId,
      sets.flatMap((set) => set.itemIds),
    );
    const garments = await ownedGarments(
      tx,
      ownerId,
      sets.flatMap((set) => set.garmentIds),
    );
    // Each id once: a form may post one twice.
    const owned = (
      set: CandidateSet | undefined,
      garmentIds: Map<number, boolean>,
      wishlistOnly: boolean,
    ): CandidateSet => ({
      itemIds: [...new Set(set?.itemIds)].filter((id) => items.has(id)),
      garmentIds: [...new Set(set?.garmentIds)].filter(
        (id) => garmentIds.has(id) && (!wishlistOnly || garmentIds.get(id)),
      ),
    });
    const remove = owned(change.remove, garments, false);
    const add = owned(change.add, garments, true);
    const over = await itemsPastCap(tx, add, remove);
    if (over.length > 0) throw new TooManyCandidates(over);
    let removed = 0;
    if (remove.itemIds.length > 0 && remove.garmentIds.length > 0) {
      removed = (
        await tx
          .delete(planItemCandidate)
          .where(
            and(
              inArray(planItemCandidate.planItemId, remove.itemIds),
              inArray(planItemCandidate.garmentId, remove.garmentIds),
            ),
          )
          .returning({ garmentId: planItemCandidate.garmentId })
      ).length;
    }
    let added = 0;
    if (add.itemIds.length > 0 && add.garmentIds.length > 0) {
      added = (
        await tx
          .insert(planItemCandidate)
          .values(
            add.itemIds.flatMap((planItemId) =>
              add.garmentIds.map((garmentId) => ({ planItemId, garmentId })),
            ),
          )
          .onConflictDoNothing()
          .returning({ garmentId: planItemCandidate.garmentId })
      ).length;
    }
    return { added, removed };
  });
}

/** Each item's candidates still on the wishlist: what the cap counts. */
async function wishlistCandidates(
  db: Queryable,
  itemIds: number[],
): Promise<Map<number, Set<number>>> {
  const rows = await db
    .select({
      itemId: planItemCandidate.planItemId,
      garmentId: planItemCandidate.garmentId,
    })
    .from(planItemCandidate)
    .innerJoin(garment, eq(garment.id, planItemCandidate.garmentId))
    .where(and(inArray(planItemCandidate.planItemId, itemIds), onWishlist()));
  const byItem = new Map<number, Set<number>>();
  for (const { itemId, garmentId } of rows) {
    byItem.set(itemId, (byItem.get(itemId) ?? new Set()).add(garmentId));
  }
  return byItem;
}

/**
 * The items `add` would take past MAX_CANDIDATES_PER_ITEM, after `remove`:
 * only items that gain a candidate count, so one already past the cap may
 * still lose some.
 */
async function itemsPastCap(
  tx: Queryable,
  add: CandidateSet,
  remove: CandidateSet,
): Promise<number[]> {
  if (add.itemIds.length === 0 || add.garmentIds.length === 0) return [];
  const current = await wishlistCandidates(tx, add.itemIds);
  return add.itemIds.filter((itemId) => {
    const kept = new Set(current.get(itemId));
    if (remove.itemIds.includes(itemId)) {
      for (const garmentId of remove.garmentIds) kept.delete(garmentId);
    }
    const gained = add.garmentIds.filter((id) => !kept.has(id));
    return (
      gained.length > 0 && kept.size + gained.length > MAX_CANDIDATES_PER_ITEM
    );
  });
}

/**
 * Refuses ahead of time (TooManyCandidates) when `ownerId`'s item `itemId`
 * already holds MAX_CANDIDATES_PER_ITEM candidates: the garment form's and
 * the link import's `planItem`, add_candidate (MCP), before a garment is
 * made or a page fetched for a link that cannot be added. Only a courtesy:
 * changeCandidates' count, under the lock, is the rule.
 */
export async function requireCandidateRoom(
  db: Queryable,
  itemId: number,
): Promise<void> {
  const held = (await wishlistCandidates(db, [itemId])).get(itemId);
  if ((held?.size ?? 0) >= MAX_CANDIDATES_PER_ITEM) {
    throw new TooManyCandidates([itemId]);
  }
}

/** Which of `ids` are items of `ownerId`'s plans, locked FOR SHARE. */
async function ownedItems(
  tx: Queryable,
  ownerId: number,
  ids: number[],
): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const rows = await tx
    .select({ id: planItem.id })
    .from(planItem)
    .innerJoin(wardrobePlan, eq(wardrobePlan.id, planItem.planId))
    .where(and(eq(wardrobePlan.ownerId, ownerId), inArray(planItem.id, ids)))
    .for('share', { of: planItem });
  return new Set(rows.map((row) => row.id));
}

/**
 * Which of `ids` are garments of `ownerId`'s wardrobe, locked FOR SHARE,
 * each with whether it is on the wishlist.
 */
async function ownedGarments(
  tx: Queryable,
  ownerId: number,
  ids: number[],
): Promise<Map<number, boolean>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: garment.id, status: garment.status })
    .from(garment)
    .where(and(eq(garment.ownerId, ownerId), inArray(garment.id, ids)))
    .for('share');
  return new Map(rows.map((row) => [row.id, row.status === 'wishlist']));
}

// ---- Reads ------------------------------------------------------------------

/**
 * A candidate product of a plan item: what the shopping list shows (photo,
 * name, price, link) and what the item judges it by (targetDifferences).
 */
export interface CandidateGarment extends PieceSpec {
  itemId: number;
  garmentId: number;
  name: string | null;
  brand: string | null;
  colors: GarmentColor[];
  materials: Material[];
  warmth: Warmth | null;
  formality: Formality | null;
  /** The listed price, '49.90'; null when unknown. */
  price: string | null;
  /** The product page (http(s) only: readSourceUrl and the column's check). */
  sourceUrl: string | null;
  photo: ImageRef | null;
}

/**
 * The wishlist candidates of `ownerId`'s items matching `which` (a plan's
 * items, or the items named), oldest link first. One statement.
 */
function candidateRows(db: Queryable, ownerId: number, which: SQL) {
  return db
    .select({
      itemId: planItemCandidate.planItemId,
      garmentId: garment.id,
      name: garment.name,
      brand: garment.brand,
      category: garment.category,
      type: garment.type,
      colors: garment.colors,
      materials: garment.materials,
      warmth: garment.warmth,
      formality: garment.formality,
      price: garment.price,
      sourceUrl: garment.sourceUrl,
      photo: { fileName: file.fileName, version: file.version },
    })
    .from(planItemCandidate)
    .innerJoin(planItem, eq(planItem.id, planItemCandidate.planItemId))
    .innerJoin(wardrobePlan, eq(wardrobePlan.id, planItem.planId))
    .innerJoin(garment, eq(garment.id, planItemCandidate.garmentId))
    .leftJoin(file, eq(file.id, garment.photoId))
    .where(
      and(
        which,
        eq(wardrobePlan.ownerId, ownerId),
        // The writer's rule, kept on read: never another wardrobe's garment.
        eq(garment.ownerId, ownerId),
        onWishlist(),
      ),
    )
    .orderBy(asc(planItemCandidate.createdAt), asc(garment.id))
    .then((rows) =>
      rows.map(({ colors, materials, ...row }) => ({
        ...row,
        colors: colors ?? [],
        materials: materials ?? [],
      })),
    );
}

/** Candidates by item id: the plans' pages and tools. */
export type CandidatesByItem = Map<number, CandidateGarment[]>;

/** `rows` by `key`, each group in the rows' order (Map.groupBy is ES2024; the build targets ES2023). */
function groupBy<T>(
  rows: readonly T[],
  key: (row: T) => number,
): Map<number, T[]> {
  const map = new Map<number, T[]>();
  for (const row of rows) {
    const group = map.get(key(row));
    if (group) group.push(row);
    else map.set(key(row), [row]);
  }
  return map;
}

function byItem(rows: CandidateGarment[]): CandidatesByItem {
  return groupBy(rows, (row) => row.itemId);
}

/** The candidates of every item of `ownerId`'s plan `planId` (the gap view, the shopping list). */
export async function candidatesOfPlan(
  db: Queryable,
  ownerId: number,
  planId: number,
): Promise<CandidatesByItem> {
  return byItem(await candidateRows(db, ownerId, eq(planItem.planId, planId)));
}

/** The candidates of `ownerId`'s items `itemIds`. */
export async function candidatesOfItems(
  db: Queryable,
  ownerId: number,
  itemIds: number[],
): Promise<CandidatesByItem> {
  if (itemIds.length === 0) return new Map();
  return byItem(
    await candidateRows(db, ownerId, inArray(planItem.id, itemIds)),
  );
}

/** A plan item a wishlist garment is a candidate for, as a link to it reads. */
export interface Candidacy {
  garmentId: number;
  itemId: number;
  planId: number;
  planName: string;
  planActive: boolean;
  /** The item's fields its title is made of (itemTitle). */
  name: string | null;
  category: string;
  type: string | null;
  colors: GarmentColor[] | null;
}

/**
 * Which of `ownerId`'s plan items each of `garmentIds` is a candidate for:
 * the wishlist's cards and "Bought it". Links of garments no longer on the
 * wishlist are left out (they stopped mattering). The active plan first.
 */
export async function candidaciesOf(
  db: Queryable,
  ownerId: number,
  garmentIds: number[],
): Promise<Candidacy[]> {
  if (garmentIds.length === 0) return [];
  return db
    .select({
      garmentId: planItemCandidate.garmentId,
      itemId: planItem.id,
      planId: wardrobePlan.id,
      planName: wardrobePlan.name,
      planActive: wardrobePlan.active,
      name: planItem.name,
      category: planItem.category,
      type: planItem.type,
      colors: planItem.colors,
    })
    .from(planItemCandidate)
    .innerJoin(planItem, eq(planItem.id, planItemCandidate.planItemId))
    .innerJoin(wardrobePlan, eq(wardrobePlan.id, planItem.planId))
    .innerJoin(garment, eq(garment.id, planItemCandidate.garmentId))
    .where(
      and(
        inArray(planItemCandidate.garmentId, garmentIds),
        eq(wardrobePlan.ownerId, ownerId),
        eq(garment.ownerId, ownerId),
        onWishlist(),
      ),
    )
    .orderBy(
      asc(planItemCandidate.garmentId),
      desc(wardrobePlan.active),
      asc(planItem.id),
    );
}

/** candidaciesOf by garment id: the wishlist's cards. */
export async function candidaciesByGarment(
  db: Queryable,
  ownerId: number,
  garmentIds: number[],
): Promise<Map<number, Candidacy[]>> {
  return groupBy(
    await candidaciesOf(db, ownerId, garmentIds),
    (candidacy) => candidacy.garmentId,
  );
}
