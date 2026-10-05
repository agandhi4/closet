import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db, Queryable } from '../../db/client';
import {
  file,
  garment,
  planItem,
  planItemCandidate,
  planLook,
  planLookSlot,
  wardrobePlan,
} from '../../db/schema';
import type { PlanItemReview } from '../../wardrobe/plan-review';
import type { PieceSpec } from '../../wardrobe/plans';
import {
  type Formality,
  type GarmentColor,
  type Material,
  type Warmth,
} from '../../wardrobe/properties';
import { ownerTransaction } from '../auth/queries';
import { HttpError } from '../errors';
import type { SignablePhotoRef } from '../files/image-url';
import { photoRefJson } from '../files/queries';
import { t } from '../i18n';
import { onWishlist } from '../wardrobe/status';
import { itemsToBuy } from './gaps';
import { itemNotFound } from './validation';

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

/**
 * The agent's research on a candidate (#293): why the option fits and its
 * place among the item's options (1 is the pick, at most
 * MAX_CANDIDATES_PER_ITEM). null: none. The owner's own adds carry none.
 */
export interface CandidateResearch {
  note: string | null;
  rank: number | null;
}

/** A set to add, with the research each of its garments is added with. */
export interface CandidateAdd extends CandidateSet {
  research?: ReadonlyMap<number, CandidateResearch>;
}

/**
 * A change of research on an existing link. A field left out stays as it is;
 * null clears it.
 */
export interface CandidateResearchUpdate {
  itemId: number;
  garmentId: number;
  note?: string | null;
  rank?: number | null;
}

export interface CandidateChange {
  /**
   * One set, or several whose pairings differ per item: a duplicated plan
   * links each copy to its own original's candidates, all in one change.
   * A pairing already linked is kept as it is, its research too: change
   * that with `update`.
   */
  add?: CandidateAdd | readonly CandidateAdd[];
  remove?: CandidateSet;
  update?: readonly CandidateResearchUpdate[];
}

/** The longest note on a candidate: it is drawn under a tile 7 rem wide. */
export const CANDIDATE_NOTE_MAX = 240;

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
 * A candidate note past CANDIDATE_NOTE_MAX: nothing was written. A 400 with
 * the reason; the writer enforces the cap so no caller (MCP's input schema
 * is only the first line) can store a note the tiles cannot hold.
 */
export class CandidateNoteTooLong extends HttpError {
  constructor() {
    super(
      400,
      t('shopping.CANDIDATE_NOTE_TOO_LONG', { max: CANDIDATE_NOTE_MAX }),
    );
    this.name = 'CandidateNoteTooLong';
  }
}

/** A note as stored: trimmed, null when blank; CandidateNoteTooLong past the cap. */
function checkedNote(
  note: string | null | undefined,
): string | null | undefined {
  if (note === undefined || note === null) return note;
  const trimmed = note.trim();
  if (trimmed.length > CANDIDATE_NOTE_MAX) throw new CandidateNoteTooLong();
  return trimmed === '' ? null : trimmed;
}

/** `change`'s adds and updates with every note checked (checkedNote). */
function checkedNotes(change: CandidateChange): {
  adds: CandidateAdd[];
  updates: CandidateResearchUpdate[];
} {
  const adds = [change.add ?? []].flat().map((set) => ({
    ...set,
    research:
      set.research &&
      new Map(
        [...set.research].map(([garmentId, research]) => [
          garmentId,
          { ...research, note: checkedNote(research.note) ?? null },
        ]),
      ),
  }));
  const updates = (change.update ?? []).map((u) => ({
    ...u,
    note: checkedNote(u.note),
  }));
  return { adds, updates };
}

/**
 * An add to an item the owner declined ("Don't buy", #278): nothing was
 * written. A 409 with the reason; the owner reconsiders the item first,
 * and the agent never works on a declined item. Thrown, like
 * TooManyCandidates, so a garment saved with the link rolls back.
 */
export class CandidateForDeclinedItem extends HttpError {
  constructor(readonly itemIds: number[]) {
    super(409, t('plans.DECLINED_NO_CANDIDATES'));
    this.name = 'CandidateForDeclinedItem';
  }
}

/**
 * The one writer of plan_item_candidate: removes every pairing in `remove`,
 * then adds every pairing in `add` (one already there is kept), in one
 * transaction. Only items of `ownerId`'s plans and garments of their
 * wardrobe take part, and only wishlist garments are added (a candidate is
 * something not owned yet); any other id is dropped. An add that would take
 * an item past MAX_CANDIDATES_PER_ITEM throws TooManyCandidates, and one
 * to a declined item CandidateForDeclinedItem (an `update` of one too), before anything is written, counted under lockOwner (the owner's user row), so
 * two adds at once (two tabs, an agent beside the app) cannot both pass the
 * count. Both sides are locked FOR SHARE, so an item or garment deleted
 * meanwhile waits for this to commit rather than failing a foreign key
 * halfway. The item's candidates page, the wishlist item's "For plan
 * item…", the garment form's `planItem`, add_candidate (MCP), a plan's
 * duplicate and the seed all go through it. A savepoint inside a caller's
 * transaction. Its statements do not grow with the change: a caller with
 * many items to link (a duplicate, the seed) passes them as one change,
 * never one call per item (#167: a duplicate did, eight statements each).
 *
 * `update` sets the research (note, rank) of links that exist, on items of
 * the owner's and wishlist garments, after the removals and additions; one
 * statement, `updated` counts the links it found. An add carries research
 * with its garments; the owner's own adds carry none.
 */
export function changeCandidates(
  db: Queryable,
  ownerId: number,
  change: CandidateChange,
): Promise<{ added: number; removed: number; updated: number }> {
  // The owner lock first, before the rows below: the cap's count must see
  // every other change of this owner's candidates committed.
  return ownerTransaction(db, ownerId, 'changeCandidates', async (tx) => {
    // Before any statement past the lock: a refused note writes nothing.
    const { adds, updates } = checkedNotes(change);
    const sets = [
      ...adds,
      ...(change.remove ? [change.remove] : []),
      {
        itemIds: updates.map((u) => u.itemId),
        garmentIds: updates.map((u) => u.garmentId),
      },
    ];
    // One lock statement per side for the whole change, however many sets.
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
    const remove: CandidateSet = {
      // Each id once: a form may post one twice.
      itemIds: [...new Set(change.remove?.itemIds)].filter((id) =>
        items.has(id),
      ),
      garmentIds: [...new Set(change.remove?.garmentIds)].filter((id) =>
        garments.has(id),
      ),
    };
    const add = addedPairings(adds, items, garments);
    const declined = [
      ...new Set([...add.keys(), ...updates.map((u) => u.itemId)]),
    ].filter((id) => items.get(id) === 'declined');
    if (declined.length > 0) throw new CandidateForDeclinedItem(declined);
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
    if (add.size > 0) {
      added = (
        await tx
          .insert(planItemCandidate)
          .values(
            [...add].flatMap(([planItemId, byGarment]) =>
              [...byGarment].map(([garmentId, research]) => ({
                planItemId,
                garmentId,
                note: research?.note ?? null,
                rank: research?.rank ?? null,
              })),
            ),
          )
          .onConflictDoNothing()
          .returning({ garmentId: planItemCandidate.garmentId })
      ).length;
    }
    const updated = await updateResearch(tx, updates, items, garments);
    return { added, removed, updated };
  });
}

/**
 * The pairings `adds` asks for among the owner's items and wishlist
 * garments, by item (each garment once, with its research when the set
 * brings some; the first set naming a pairing wins): what changeCandidates
 * inserts. Items left with nothing to gain are dropped.
 */
function addedPairings(
  adds: readonly CandidateAdd[],
  items: ReadonlyMap<number, PlanItemReview>,
  garments: Map<number, boolean>,
): Map<number, Map<number, CandidateResearch | undefined>> {
  const byItem = new Map<number, Map<number, CandidateResearch | undefined>>();
  for (const set of adds) {
    const garmentIds = set.garmentIds.filter((id) => garments.get(id));
    if (garmentIds.length === 0) continue;
    for (const itemId of set.itemIds) {
      if (!items.has(itemId)) continue;
      const held =
        byItem.get(itemId) ?? new Map<number, CandidateResearch | undefined>();
      garmentIds
        .filter((garmentId) => !held.has(garmentId))
        .forEach((garmentId) =>
          held.set(garmentId, set.research?.get(garmentId)),
        );
      byItem.set(itemId, held);
    }
  }
  return byItem;
}

/**
 * Sets the research of the links `updates` names, in one statement, for the
 * owner's items and wishlist garments (both already locked). Counts the
 * links found, so a caller can tell a non-candidate from a change.
 */
async function updateResearch(
  tx: Queryable,
  updates: readonly CandidateResearchUpdate[],
  items: ReadonlyMap<number, PlanItemReview>,
  garments: ReadonlyMap<number, boolean>,
): Promise<number> {
  const wanted = updates.filter(
    (u) => items.has(u.itemId) && garments.get(u.garmentId),
  );
  if (wanted.length === 0) return 0;
  const values = sql.join(
    wanted.map(
      (u) =>
        sql`(${u.itemId}::int, ${u.garmentId}::int, ${u.note !== undefined}::boolean, ${u.note ?? null}::text, ${u.rank !== undefined}::boolean, ${u.rank ?? null}::smallint)`,
    ),
    sql`, `,
  );
  const result = await tx.execute(sql`
    update ${planItemCandidate} as c
    set note = case when v.set_note then v.note else c.note end,
        rank = case when v.set_rank then v.rank else c.rank end
    from (values ${values}) as v(item_id, garment_id, set_note, note, set_rank, rank)
    where c.plan_item_id = v.item_id and c.garment_id = v.garment_id`);
  return result.rowCount ?? 0;
}

/**
 * Links `garmentId`, a wishlist item this save just made, to `ownerId`'s
 * item `itemId`, in the garment's own transaction (WithGarment): the
 * garment form's and the link import's `planItem`, add_candidate by url.
 * The item was checked before the save, but a slow product page leaves
 * time to delete it: changeCandidates then drops its id and links nothing,
 * so this throws the item's 404 and the garment's save rolls back, never
 * leaving a wishlist item without the link it was added for.
 */
export async function linkNewCandidate(
  tx: Queryable,
  ownerId: number,
  itemId: number,
  garmentId: number,
  research?: CandidateResearch,
): Promise<void> {
  const { added } = await changeCandidates(tx, ownerId, {
    add: {
      itemIds: [itemId],
      garmentIds: [garmentId],
      research: research && new Map([[garmentId, research]]),
    },
  });
  if (added === 0) throw itemNotFound();
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
 * The items `add` (garments by item) would take past
 * MAX_CANDIDATES_PER_ITEM, after `remove`: only items that gain a
 * candidate count, so one already past the cap may still lose some. One
 * statement for every item added to.
 */
async function itemsPastCap(
  tx: Queryable,
  add: Map<number, Map<number, CandidateResearch | undefined>>,
  remove: CandidateSet,
): Promise<number[]> {
  if (add.size === 0) return [];
  const current = await wishlistCandidates(tx, [...add.keys()]);
  return [...add].flatMap(([itemId, byGarment]) => {
    const garmentIds = byGarment.keys();
    const kept = new Set(current.get(itemId));
    if (remove.itemIds.includes(itemId)) {
      for (const garmentId of remove.garmentIds) kept.delete(garmentId);
    }
    const gained = [...garmentIds].filter((id) => !kept.has(id));
    return gained.length > 0 &&
      kept.size + gained.length > MAX_CANDIDATES_PER_ITEM
      ? [itemId]
      : [];
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

/** Which of `ids` are items of `ownerId`'s plans, locked FOR SHARE, each with its review. */
async function ownedItems(
  tx: Queryable,
  ownerId: number,
  ids: number[],
): Promise<Map<number, PlanItemReview>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: planItem.id, review: planItem.review })
    .from(planItem)
    .innerJoin(wardrobePlan, eq(wardrobePlan.id, planItem.planId))
    .where(and(eq(wardrobePlan.ownerId, ownerId), inArray(planItem.id, ids)))
    .orderBy(planItem.id)
    .for('share', { of: planItem });
  return new Map(rows.map((row) => [row.id, row.review]));
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
    // Id order, as every multi-row garment locker takes them (pickedGarments).
    .orderBy(garment.id)
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
  photo: SignablePhotoRef | null;
  /** The agent's note on why it fits (#293); null on the owner's own adds. */
  note: string | null;
  /** The agent's place for it among the item's options, 1 the pick; null: unranked. */
  rank: number | null;
  /** The looks of its item's plan holding it, declined ones aside, and how many are loved (#292). */
  looks: LookCount;
}

export interface LookCount {
  total: number;
  loved: number;
}

/**
 * How many looks of the candidate's own plan (its item's) hold it, declined
 * ones left out, and how many of those the owner loved: "In 3 looks, 2
 * loved" on the review and shopping strips (#292), which product unlocks
 * the most outfits. A column of candidateRows, correlated on the joined
 * plan_item and garment (a joined select, so drizzle keeps their tables;
 * src/db/CLAUDE.md), over plan_look_slot_garment_id_index: no statement of
 * its own on any page. Looks are owner-only like their plan, which
 * candidateRows already holds to the owner.
 */
function lookCountSql(): SQL<LookCount> {
  return sql<LookCount>`(select json_build_object(
    'total', count(*)::int,
    'loved', (count(*) filter (where ${planLook.reaction} = 'loved'))::int
  ) from ${planLookSlot}
    inner join ${planLook} on ${planLook.id} = ${planLookSlot.lookId}
    where ${planLookSlot.garmentId} = ${garment.id}
      and ${planLook.planId} = ${planItem.planId}
      and ${planLook.reaction} <> 'declined')`;
}

/**
 * How many loved looks of the candidate's own plan this candidate COMPLETES:
 * every other slot is an owned closet garment of `ownerId`'s (no other
 * wishlist product, no archived, deleted or empty slot), so buying it is
 * the one thing left. A sibling of lookCountSql, correlated the same way
 * on the joined plan_item and garment; Today's next step ranks by it (#302).
 */
function completedLookCountSql(ownerId: number): SQL<number> {
  const other = alias(planLookSlot, 'other_slot');
  const owned = alias(garment, 'owned_garment');
  return sql<number>`(select count(*)::int from ${planLookSlot}
    inner join ${planLook} on ${planLook.id} = ${planLookSlot.lookId}
    where ${planLookSlot.garmentId} = ${garment.id}
      and ${planLook.planId} = ${planItem.planId}
      and ${planLook.reaction} = 'loved'
      and not exists (
        select from ${planLookSlot} ${other}
        left join ${garment} ${owned} on ${owned.id} = ${other.garmentId}
        where ${other.lookId} = ${planLook.id}
          and ${other.position} <> ${planLookSlot.position}
          and (${owned.id} is null
            or ${owned.status} <> 'closet'
            or ${owned.ownerId} <> ${ownerId})))`;
}

/** The product to buy next: the one that completes the most loved looks of the active plan. */
export interface NextPurchase {
  garmentId: number;
  /** The item the shopping list shows it under (the first still to buy), for the card's anchor. */
  itemId: number;
  name: string | null;
  category: string;
  /** Loved looks it completes (completedLookCountSql, never zero). */
  completes: number;
}

/** A loved-look product of the active plan, ranked, with the accepted items it is a candidate of. */
export interface RankedPurchase extends Omit<NextPurchase, 'itemId'> {
  planId: number;
  itemIds: number[];
}

/**
 * The first step of Today's next step (#302) as a scalar subquery: every
 * wishlist product of `ownerId`'s active plan that is a candidate of an
 * ACCEPTED item and completes a loved look (completedLookCountSql), best
 * first: the most completed looks, then the most looks of any kind
 * (lookCountSql, the strips' count), then the lowest garment
 * id, the same answer on every read. A product that is a candidate of two
 * items is one entry. Read beside the day in todayFor's one statement, so
 * the home screen's statement count stays; nextPurchaseOf finishes it.
 */
export function rankedPurchasesSql(ownerId: number): SQL<RankedPurchase[]> {
  return sql<RankedPurchase[]>`(
    select coalesce(json_agg(json_build_object(
      'garmentId', best.id, 'name', best.name, 'category', best.category,
      'completes', best.completes, 'planId', best.plan_id,
      'itemIds', best.item_ids)
      order by best.completes desc,
        (best.looks->>'total')::int desc, best.id), '[]')
    from (
      select ${garment.id} as id, ${garment.name} as name,
        ${garment.category} as category, ${planItem.planId} as plan_id,
        json_agg(${planItem.id} order by ${planItem.id}) as item_ids,
        ${lookCountSql()} as looks,
        ${completedLookCountSql(ownerId)} as completes
      from ${planItemCandidate}
      inner join ${planItem} on ${planItem.id} = ${planItemCandidate.planItemId}
      inner join ${wardrobePlan} on ${wardrobePlan.id} = ${planItem.planId}
      inner join ${garment} on ${garment.id} = ${planItemCandidate.garmentId}
      where ${wardrobePlan.ownerId} = ${ownerId}
        and ${wardrobePlan.active}
        and ${planItem.review} = 'accepted'
        and ${garment.ownerId} = ${ownerId}
        and ${onWishlist()}
      group by ${garment.id}, ${planItem.planId}
    ) best
    where best.completes > 0)`;
}

/**
 * Today's next step: the first of `ranked` that is a candidate of an item
 * the shopping strip lists, an accepted item still missing or partly owned
 * (planShoppingList's rule). Whether the closet already covers an item is
 * matchPlan's greedy assignment over the whole closet, which SQL cannot
 * express, so with something ranked this reads the plan's items and the
 * closet once more (itemsToBuy, two statements in parallel); with nothing
 * ranked it reads nothing.
 */
export async function nextPurchaseOf(
  db: Db,
  ownerId: number,
  ranked: readonly RankedPurchase[],
): Promise<NextPurchase | null> {
  if (ranked.length === 0) return null;
  const toBuy = await itemsToBuy(db, ranked[0].planId, ownerId);
  for (const next of ranked) {
    const itemId = next.itemIds.find((id) => toBuy.has(id));
    if (itemId === undefined) continue;
    return {
      garmentId: next.garmentId,
      itemId,
      name: next.name,
      category: next.category,
      completes: next.completes,
    };
  }
  return null;
}

/**
 * The wishlist candidates of `ownerId`'s items matching `which` (a plan's
 * items, or the items named): the agent's ranked ones first by rank, then
 * the oldest link first. One statement.
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
      photo: photoRefJson,
      note: planItemCandidate.note,
      rank: planItemCandidate.rank,
      looks: lookCountSql(),
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
    .orderBy(
      sql`${planItemCandidate.rank} asc nulls last`,
      asc(planItemCandidate.createdAt),
      asc(garment.id),
    )
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
