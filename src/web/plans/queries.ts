import { and, asc, desc, eq, inArray, ne, type SQL, sql } from 'drizzle-orm';
import type { Db, Queryable } from '../../db/client';
import {
  file,
  garment,
  personalAccessToken,
  PLAN_NAME_UNIQUE,
  planItem,
  styleProfile,
  wardrobePlan,
} from '../../db/schema';
import {
  type Condition,
  type Formality,
  type GarmentColor,
  type Material,
  type Warmth,
} from '../../wardrobe/properties';
import { isUniqueViolation } from '../../db/errors';
import {
  type EntryReview,
  type OwnerNoteEffect,
  type PlanItemReview,
  type PlanItemReviewEvent,
  planItemReviewTransition,
} from '../../wardrobe/plan-review';
import { ownerTransaction } from '../auth/queries';
import type { SignablePhotoRef } from '../files/image-url';
import { photoRefJson } from '../files/queries';
import { inCloset } from '../wardrobe/status';
import {
  PLAN_NAME_MAX,
  type PlanFields,
  type PlanItemFields,
  type StyleProfileFields,
} from './validation';

/**
 * Wardrobe plans' and the style profile's reads and writes (#34, slice
 * 34a). Both are the owner's own, like outfits: every query names the
 * signed-in user as the owner, a plan or item of anyone else's is a miss
 * like a missing one (the routes answer 404), and shares never reach them.
 * The one reader of another wardrobe is closetPieces, for "start from a
 * wardrobe", after the route authorized the view (authorizeWardrobe).
 *
 * One writer each: the plan's name and notes (createPlan, or
 * createGeneratedPlan for a name the app makes up; updatePlan), which
 * plan is active (setActivePlan; createPlan activates a first plan, never
 * one an agent drafted), the items (addItems, insertItems, copyItems,
 * updateItem, reviewItems, deleteItems) and the style profile (saveStyleProfile; its rhythm is the week template's, #16,
 * src/web/week-plan/template.ts). Every plan and item write holds the
 * owner lock (ownerTransaction; src/web/calendar/CLAUDE.md, Owner lock), so
 * which plan is active and whether a plan still exists are decided with
 * no other write of the owner's in between.
 */

export interface PlanDetail {
  id: number;
  name: string;
  notes: string | null;
  active: boolean;
  /**
   * The name of the personal access token whose agent drafted it
   * (create_plan, #269), or null for the owner's own. Only the name: the
   * pages never show a token's prefix or hash.
   */
  draftedBy: string | null;
}

/** A stored plan item. */
export interface PlanItemRow extends PlanItemFields {
  id: number;
  planId: number;
  /** Where the owner's review of it stands (src/wardrobe/plan-review.ts); only accepted is matched. */
  review: PlanItemReview;
  /** The owner's word to the agent with Change this or Don't buy; apart from the agent's `note`. */
  ownerNote: string | null;
  /** When the agent last wrote it (null: never); a rejection after it is news to the agent (get_plan_feedback). The owner's writes never touch it. */
  agentChangedAt: Date | null;
}

/** A stored item's fields, as a write takes them (duplicating a plan). */
export function itemFields(item: PlanItemRow): PlanItemFields {
  return {
    name: item.name,
    category: item.category,
    type: item.type,
    colors: item.colors,
    materials: item.materials,
    warmthMin: item.warmthMin,
    warmthMax: item.warmthMax,
    formalityMin: item.formalityMin,
    formalityMax: item.formalityMax,
    quantity: item.quantity,
    priority: item.priority,
    budget: item.budget,
    note: item.note,
  };
}

type NameTaken = 'name-taken';

const PLAN_COLUMNS = {
  id: wardrobePlan.id,
  name: wardrobePlan.name,
  notes: wardrobePlan.notes,
  active: wardrobePlan.active,
  // A scalar subquery rather than a join, so every plan read (findPlanItem's
  // left join included) takes the column as it is, read by the token's
  // primary key.
  draftedBy: sql<
    string | null
  >`(select ${personalAccessToken.name} from ${personalAccessToken} where ${personalAccessToken.id} = ${wardrobePlan.draftedByTokenId})`,
};

/** Active first, then by name: the list page and list_plans. */
export function listPlans(db: Db, ownerId: number): Promise<PlanDetail[]> {
  return db
    .select(PLAN_COLUMNS)
    .from(wardrobePlan)
    .where(eq(wardrobePlan.ownerId, ownerId))
    .orderBy(
      desc(wardrobePlan.active),
      asc(sql`lower(${wardrobePlan.name})`),
      asc(wardrobePlan.id),
    );
}

/** The owner's plan `id`, or undefined (someone else's reads the same). */
export async function findPlan(
  db: Queryable,
  id: number,
  ownerId: number,
): Promise<PlanDetail | undefined> {
  const [row] = await db
    .select(PLAN_COLUMNS)
    .from(wardrobePlan)
    .where(and(eq(wardrobePlan.id, id), eq(wardrobePlan.ownerId, ownerId)));
  return row;
}

/** The owner's active plan, if one is. */
export async function findActivePlan(
  db: Db,
  ownerId: number,
): Promise<PlanDetail | undefined> {
  const [row] = await db
    .select(PLAN_COLUMNS)
    .from(wardrobePlan)
    .where(and(eq(wardrobePlan.ownerId, ownerId), wardrobePlan.active));
  return row;
}

const ITEM_COLUMNS = {
  id: planItem.id,
  planId: planItem.planId,
  name: planItem.name,
  category: planItem.category,
  type: planItem.type,
  colors: planItem.colors,
  materials: planItem.materials,
  warmthMin: planItem.warmthMin,
  warmthMax: planItem.warmthMax,
  formalityMin: planItem.formalityMin,
  formalityMax: planItem.formalityMax,
  quantity: planItem.quantity,
  priority: planItem.priority,
  budget: planItem.budget,
  note: planItem.note,
  review: planItem.review,
  ownerNote: planItem.ownerNote,
  agentChangedAt: planItem.agentChangedAt,
};

/** The items of the plans `planIds` (the owner's, checked by the caller), oldest first. */
export function itemsOf(
  db: Queryable,
  planIds: number[],
): Promise<PlanItemRow[]> {
  if (planIds.length === 0) return Promise.resolve([]);
  return db
    .select(ITEM_COLUMNS)
    .from(planItem)
    .where(inArray(planItem.planId, planIds))
    .orderBy(asc(planItem.id));
}

/**
 * The owner's plan `planId` with its item `itemId` (undefined when the
 * plan has no such item), or undefined when the plan is not the owner's:
 * the routes' lookup by path ids (require.ts), which answers each miss
 * with its own 404. One statement, the item left-joined to the plan.
 */
export async function findPlanItem(
  db: Db,
  planId: number,
  itemId: number,
  ownerId: number,
): Promise<{ plan: PlanDetail; item: PlanItemRow | undefined } | undefined> {
  const [row] = await db
    .select({ plan: PLAN_COLUMNS, item: ITEM_COLUMNS })
    .from(wardrobePlan)
    .leftJoin(
      planItem,
      and(eq(planItem.planId, wardrobePlan.id), eq(planItem.id, itemId)),
    )
    .where(and(eq(wardrobePlan.id, planId), eq(wardrobePlan.ownerId, ownerId)));
  return row && { plan: row.plan, item: row.item ?? undefined };
}

/**
 * Item `itemId` of any of the owner's plans, or undefined: the MCP tools
 * name an item by its id alone.
 */
export async function findOwnedItem(
  db: Db,
  itemId: number,
  ownerId: number,
): Promise<PlanItemRow | undefined> {
  const [row] = await db
    .select(ITEM_COLUMNS)
    .from(planItem)
    .innerJoin(wardrobePlan, eq(wardrobePlan.id, planItem.planId))
    .where(and(eq(planItem.id, itemId), eq(wardrobePlan.ownerId, ownerId)));
  return row;
}

/** A garment of a closet, as matching and the gap view read it. */
export interface ClosetGarment {
  id: number;
  name: string | null;
  brand: string | null;
  category: string;
  type: string | null;
  colors: GarmentColor[];
  materials: Material[];
  warmth: Warmth | null;
  formality: Formality | null;
  quantity: number;
  condition: Condition;
  price: string | null;
  photo: SignablePhotoRef | null;
}

/**
 * Every garment in `ownerId`'s closet (inCloset: not the wishlist, not the
 * archive), oldest first: what a plan is matched against, and what "start
 * from a wardrobe" groups. One statement; a household closet is a few
 * hundred rows.
 */
export async function closetPieces(
  db: Queryable,
  ownerId: number,
): Promise<ClosetGarment[]> {
  const rows = await db
    .select({
      id: garment.id,
      name: garment.name,
      brand: garment.brand,
      category: garment.category,
      type: garment.type,
      colors: garment.colors,
      materials: garment.materials,
      warmth: garment.warmth,
      formality: garment.formality,
      quantity: garment.quantity,
      condition: garment.condition,
      price: garment.price,
      photo: photoRefJson,
    })
    .from(garment)
    .leftJoin(file, eq(file.id, garment.photoId))
    .where(and(eq(garment.ownerId, ownerId), inCloset()))
    .orderBy(asc(garment.id));
  return rows.map(({ colors, materials, ...row }) => ({
    ...row,
    colors: colors ?? [],
    materials: materials ?? [],
  }));
}

/** The categories of `ownerId`'s closet (the item form suggests them after the built-in ones). */
export async function closetCategories(
  db: Db,
  ownerId: number,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ category: garment.category })
    .from(garment)
    .where(and(eq(garment.ownerId, ownerId), inCloset()));
  return rows.map((row) => row.category);
}

// ---- Plan writes ------------------------------------------------------------

/**
 * Who drafted a new plan: absent, the owner; `draftedByTokenId`, the agent
 * holding that personal access token (create_plan). An agent's draft is
 * never made active, even as the owner's first plan: the active plan is
 * the owner's choice ("Make active").
 */
export interface PlanDraft {
  draftedByTokenId?: number;
}

/**
 * A new plan of `ownerId`'s under a name given by the owner or their agent
 * (the plan form, create_plan, the seed), with `items`. 'name-taken' only
 * for the name index (another of their plans has the name in any case);
 * any other violation is a bug and rethrown. A savepoint, so a caller's
 * transaction survives.
 */
export async function createPlan(
  db: Queryable,
  ownerId: number,
  fields: PlanFields,
  items: PlanItemFields[] = [],
  draft: PlanDraft = {},
): Promise<number | NameTaken> {
  try {
    return await ownerTransaction(db, ownerId, 'createPlan', (tx) =>
      insertPlan(tx, ownerId, fields, items, draft),
    );
  } catch (error) {
    if (isUniqueViolation(error, PLAN_NAME_UNIQUE)) return 'name-taken';
    throw error;
  }
}

/**
 * A name the app makes up for a new plan: `base` through `nameFor` for the
 * n-th try (n = 1, 2, ...): a duplicate's "NYC minimal (copy 2)", a
 * wardrobe's "Like Theo’s wardrobe 2".
 */
export interface GeneratedPlanName {
  base: string;
  nameFor: (base: string, n: number) => string;
}

/**
 * A new plan of `ownerId`'s under a generated name (a duplicate, "start
 * from a wardrobe"): the first try none of their plans has in any case,
 * chosen under the owner lock, in the insert's transaction. Every writer
 * of wardrobe_plan holds that lock, so the name cannot be taken between
 * the two: two taps of Duplicate queue and name their copies apart. The
 * name index firing here would mean a writer skipping the lock, a bug, so
 * it is not answered. A savepoint, so a caller's transaction survives.
 */
export function createGeneratedPlan(
  db: Queryable,
  ownerId: number,
  name: GeneratedPlanName,
  notes: string | null,
  items: PlanItemFields[] = [],
): Promise<{ id: number; name: string }> {
  return ownerTransaction(db, ownerId, 'createGeneratedPlan', async (tx) => {
    const free = await freePlanName(tx, ownerId, name);
    const id = await insertPlan(tx, ownerId, { name: free, notes }, items);
    return { id, name: free };
  });
}

/**
 * Inserts the plan with its items, under the owner lock the caller holds:
 * the owner's own is active when they have no active plan yet (their
 * first, or after deleting the active one), so the gap view always has
 * one to show once any exists; the lock makes that check and the
 * activation one step. An agent's draft never is (PlanDraft).
 */
async function insertPlan(
  tx: Queryable,
  ownerId: number,
  fields: PlanFields,
  items: PlanItemFields[],
  { draftedByTokenId }: PlanDraft = {},
): Promise<number> {
  // Decided in the insert itself: the subquery reads the owner's plans as
  // they were before this row, and the owner lock keeps them so.
  const [row] = await tx
    .insert(wardrobePlan)
    .values({
      ownerId,
      ...fields,
      draftedByTokenId,
      active:
        draftedByTokenId === undefined
          ? sql`not exists (select 1 from ${wardrobePlan} where ${wardrobePlan.ownerId} = ${ownerId} and ${wardrobePlan.active})`
          : false,
    })
    .returning({ id: wardrobePlan.id });
  await insertItems(tx, row.id, items, { review: 'accepted' });
  return row.id;
}

/**
 * The first try of `name` none of the owner's plans has in any case, read
 * under the owner lock the caller holds (createGeneratedPlan). Every try
 * fits PLAN_NAME_MAX, so the plan's edit form takes the name back: a long
 * base is cut (whole characters, trailing space dropped) and the suffix
 * kept whole; cutting the suffix instead would make "(copy 2)" and
 * "(copy 3)" one name and the search endless.
 */
async function freePlanName(
  tx: Queryable,
  ownerId: number,
  { base, nameFor }: GeneratedPlanName,
): Promise<string> {
  const taken = new Set(
    (
      await tx
        .select({ name: sql<string>`lower(${wardrobePlan.name})` })
        .from(wardrobePlan)
        .where(eq(wardrobePlan.ownerId, ownerId))
    ).map((row) => row.name),
  );
  // In code points, as the form's maxLength counts them.
  const characters = [...base];
  const fitted = (n: number): string => {
    const over = [...nameFor(base, n)].length - PLAN_NAME_MAX;
    if (over <= 0) return nameFor(base, n);
    const cut = characters.slice(0, characters.length - over);
    return nameFor(cut.join('').trimEnd(), n);
  };
  let n = 1;
  while (taken.has(fitted(n).toLowerCase())) n += 1;
  return fitted(n);
}

/** Renames it: 'not-found' outside the owner's plans, 'name-taken' for another plan's name. */
export async function updatePlan(
  db: Db,
  id: number,
  ownerId: number,
  fields: PlanFields,
): Promise<'updated' | 'not-found' | NameTaken> {
  try {
    const updated = await ownerTransaction(db, ownerId, 'updatePlan', (tx) =>
      tx
        .update(wardrobePlan)
        .set(fields)
        .where(and(eq(wardrobePlan.id, id), eq(wardrobePlan.ownerId, ownerId)))
        .returning({ id: wardrobePlan.id }),
    );
    return updated.length > 0 ? 'updated' : 'not-found';
  } catch (error) {
    if (isUniqueViolation(error, PLAN_NAME_UNIQUE)) return 'name-taken';
    throw error;
  }
}

/**
 * Deletes it with its items; false when not the owner's. The garments are
 * untouched. Under the owner lock: a first plan created meanwhile must
 * see whether the active one is gone (createPlan's activation).
 */
export async function deletePlan(
  db: Db,
  id: number,
  ownerId: number,
): Promise<boolean> {
  const deleted = await ownerTransaction(db, ownerId, 'deletePlan', (tx) =>
    tx
      .delete(wardrobePlan)
      .where(and(eq(wardrobePlan.id, id), eq(wardrobePlan.ownerId, ownerId)))
      .returning({ id: wardrobePlan.id }),
  );
  return deleted.length > 0;
}

/**
 * Makes plan `id` the owner's active one, and no other: under
 * the owner lock (so two switches, or a switch and a first plan, queue
 * instead of racing into the one-active index), the old one cleared before
 * the new one is set. False when not the owner's.
 */
export function setActivePlan(
  db: Queryable,
  id: number,
  ownerId: number,
): Promise<boolean> {
  return ownerTransaction(db, ownerId, 'setActivePlan', async (tx) => {
    if (!(await findPlan(tx, id, ownerId))) return false;
    await tx
      .update(wardrobePlan)
      .set({ active: false })
      .where(
        and(
          eq(wardrobePlan.ownerId, ownerId),
          wardrobePlan.active,
          ne(wardrobePlan.id, id),
        ),
      );
    await tx
      .update(wardrobePlan)
      .set({ active: true })
      .where(eq(wardrobePlan.id, id));
    return true;
  });
}

// ---- Item writes ------------------------------------------------------------

/**
 * Adds items to the owner's plan `planId` (the item form, propose_plan_item):
 * their ids, or undefined when the plan is not the owner's (any more: it
 * is looked up under the owner lock, so a delete that committed first is
 * a miss, never a foreign key error).
 */
export function addItems(
  db: Queryable,
  ownerId: number,
  planId: number,
  items: PlanItemFields[],
  options: { review: EntryReview },
): Promise<number[] | undefined> {
  return ownerTransaction(db, ownerId, 'addItems', async (tx) =>
    (await findPlan(tx, planId, ownerId))
      ? insertItems(tx, planId, items, options)
      : undefined,
  );
}

/**
 * Inserts items into plan `planId`, which the caller found to be the
 * owner's under the owner lock it holds (createPlan, the seed; addItems for
 * everyone else), each at its entry review: the agent's proposal or the
 * owner's own. Their ids in `items`' order.
 */
export function insertItems(
  db: Queryable,
  planId: number,
  items: PlanItemFields[],
  { review }: { review: EntryReview },
): Promise<number[]> {
  return insertRows(
    db,
    items.map((item) => ({
      ...item,
      planId,
      review,
      ownerNote: null,
      // 'proposed' is the agent's entry; the owner's own items were never its work.
      agentChangedAt: review === 'proposed' ? sql`now()` : null,
    })),
  );
}

/**
 * Copies `originals` into plan `planId` (the duplicate, under the owner
 * lock it holds), each with its review and the owner's note as they stand,
 * so a declined item stays declined in the copy and the agent working on
 * it never proposes it again. Ids in `originals`' order (the duplicate maps
 * each original to its copy).
 */
export function copyItems(
  db: Queryable,
  planId: number,
  originals: readonly PlanItemRow[],
): Promise<number[]> {
  return insertRows(
    db,
    originals.map((item) => ({
      ...itemFields(item),
      planId,
      review: item.review,
      ownerNote: item.ownerNote,
      agentChangedAt: item.agentChangedAt,
    })),
  );
}

async function insertRows(
  db: Queryable,
  rows: (Omit<typeof planItem.$inferInsert, 'agentChangedAt'> & {
    agentChangedAt: Date | SQL | null;
  })[],
): Promise<number[]> {
  if (rows.length === 0) return [];
  const inserted = await db
    .insert(planItem)
    .values(rows)
    .returning({ id: planItem.id });
  // One statement draws its serials in VALUES order; RETURNING's own order
  // is not promised, so the ids are put back in that order.
  return inserted.map((row) => row.id).sort((a, b) => a - b);
}

/** The owner's plan `planId` exists: the item writers' guard. */
function ownsPlan(planId: number, ownerId: number) {
  return sql`${planItem.planId} in (select ${wardrobePlan.id} from ${wardrobePlan} where ${wardrobePlan.id} = ${planId} and ${wardrobePlan.ownerId} = ${ownerId})`;
}

/** Who rewrote an item: the owner's form, or their agent's update_plan_item. */
export type ItemAuthor = 'owner' | 'agent';

export type ItemUpdate =
  | { ok: true; from: PlanItemReview; to: PlanItemReview }
  | { ok: false; reason: 'not-found' }
  /** A declined item: the owner reconsiders it first (a 409). */
  | { ok: false; reason: 'not-allowed'; review: PlanItemReview };

/**
 * The review move a rewrite by `author` makes, or none for a content edit:
 * the owner's save accepts what is not accepted yet; the agent's change
 * puts an item back to the owner unless it is still a proposal.
 */
function rewriteEvent(
  author: ItemAuthor,
  review: PlanItemReview,
): PlanItemReviewEvent | null {
  if (author === 'owner') return review === 'accepted' ? null : 'accept';
  return review === 'proposed' ? null : 'repropose';
}

/**
 * Rewrites item `itemId` of the owner's plan `planId` whole, moving its
 * review as `author` does (rewriteEvent, asked of the machine): the owner's
 * form accepts it, the agent's update_plan_item leaves it for the owner.
 * A declined item takes neither. The row is read under the owner lock,
 * which every item writer holds, so the review judged is the one written
 * over.
 */
export async function updateItem(
  db: Queryable,
  itemId: number,
  planId: number,
  ownerId: number,
  fields: PlanItemFields,
  author: ItemAuthor,
): Promise<ItemUpdate> {
  return ownerTransaction(db, ownerId, 'updateItem', async (tx) => {
    const [row] = await tx
      .select({ review: planItem.review, ownerNote: planItem.ownerNote })
      .from(planItem)
      .where(and(eq(planItem.id, itemId), ownsPlan(planId, ownerId)));
    if (!row) return { ok: false as const, reason: 'not-found' as const };
    const event = rewriteEvent(author, row.review);
    const move = event
      ? planItemReviewTransition(row.review, event)
      : ({
          ok: true,
          from: row.review,
          to: row.review,
          note: 'keep',
        } as const);
    if (!move.ok) {
      return {
        ok: false as const,
        reason: 'not-allowed' as const,
        review: move.review,
      };
    }
    await tx
      .update(planItem)
      .set({
        ...fields,
        review: move.to,
        ownerNote: move.note === 'keep' ? row.ownerNote : null,
        ...(author === 'agent' ? { agentChangedAt: sql`now()` } : {}),
      })
      .where(eq(planItem.id, itemId));
    return { ok: true as const, from: move.from, to: move.to };
  });
}

/** One item a review move names, with the owner's note when the move writes one. */
export interface ReviewMove {
  itemId: number;
  note?: string | null;
}

export interface ReviewMoves {
  /** The items moved, in id order. */
  moved: number[];
  /** Items of the plan whose review does not take the event, with where they stay. */
  refused: { itemId: number; review: PlanItemReview }[];
}

/**
 * The one writer of the owner's review moves (src/wardrobe/plan-review.ts):
 * `event` on the owner's plan `planId`'s items `moves`, each asked of the
 * machine against its stored review, under the owner lock (every item
 * writer holds it, so nothing moves the item in between). Ids that are no
 * item of the plan are in neither list (the route's 404). Two statements
 * however many: the read, and one update (each item's note a case of it).
 * The item's Accept, Change this, Don't buy and Reconsider, and the plan
 * review's post (#271, #278), one call per event. A `change` needs a note
 * (the caller's 400; the column's check backs it).
 */
export async function reviewItems(
  db: Queryable,
  ownerId: number,
  planId: number,
  event: PlanItemReviewEvent,
  moves: readonly ReviewMove[],
): Promise<ReviewMoves> {
  if (moves.length === 0) return { moved: [], refused: [] };
  return ownerTransaction(db, ownerId, 'reviewItems', async (tx) => {
    const rows = await tx
      .select({ id: planItem.id, review: planItem.review })
      .from(planItem)
      .where(
        and(
          inArray(
            planItem.id,
            moves.map((move) => move.itemId),
          ),
          ownsPlan(planId, ownerId),
        ),
      )
      .orderBy(asc(planItem.id));
    const moved: number[] = [];
    const refused: ReviewMoves['refused'] = [];
    let to: PlanItemReview | undefined;
    let effect: OwnerNoteEffect = 'keep';
    for (const row of rows) {
      const move = planItemReviewTransition(row.review, event);
      if (move.ok) {
        moved.push(row.id);
        // One event: every move leads to the same review, with the same effect.
        to = move.to;
        effect = move.note;
      } else {
        refused.push({ itemId: row.id, review: move.review });
      }
    }
    if (to === undefined) return { moved, refused };
    const notes = new Map(
      moves.map((move) => [move.itemId, move.note ?? null]),
    );
    await tx
      .update(planItem)
      .set({
        review: to,
        ...ownerNoteSet(effect, moved, notes),
      })
      .where(inArray(planItem.id, moved));
    return { moved, refused };
  });
}

/** What a move's note effect sets: nothing, null, or each item's own note. */
function ownerNoteSet(
  effect: OwnerNoteEffect,
  itemIds: readonly number[],
  notes: ReadonlyMap<number, string | null>,
): { ownerNote?: SQL | null } {
  switch (effect) {
    case 'keep':
      return {};
    case 'clear':
      return { ownerNote: null };
    case 'write':
      return {
        ownerNote: sql`case ${planItem.id} ${sql.join(
          itemIds.map(
            (id) => sql`when ${id} then ${notes.get(id) ?? null}::text`,
          ),
          sql` `,
        )} end`,
      };
  }
}

/**
 * Deletes them (an item dropped from its edit form); the ids of those
 * deleted, none when not the owner's. Their candidate links and rejections
 * go with them (the foreign keys cascade). Declining an agent's proposal
 * is a review move instead (reviewItems, "Don't buy"), kept so the agent
 * sees it.
 */
export async function deleteItems(
  db: Queryable,
  itemIds: readonly number[],
  planId: number,
  ownerId: number,
): Promise<number[]> {
  if (itemIds.length === 0) return [];
  const deleted = await ownerTransaction(db, ownerId, 'deleteItems', (tx) =>
    tx
      .delete(planItem)
      .where(and(inArray(planItem.id, [...itemIds]), ownsPlan(planId, ownerId)))
      .returning({ id: planItem.id }),
  );
  return deleted.map((row) => row.id);
}

// ---- The style profile ------------------------------------------------------

/**
 * The user's style profile as a scalar subquery (null when never saved),
 * for a read that takes it with others in one statement: get_style_profile
 * (#172) and the style page (#251) read it with the week template. Every
 * field is JSON as stored
 * (text and text arrays).
 */
export function styleProfileSql(
  userId: number,
): SQL<StyleProfileFields | null> {
  return sql<StyleProfileFields | null>`(
    select json_build_object(
      'styles', ${styleProfile.styles},
      'budget', ${styleProfile.budget},
      'palette', ${styleProfile.palette},
      'notes', ${styleProfile.notes}
    )
    from ${styleProfile} where ${eq(styleProfile.userId, userId)})`;
}

/** A draft an agent made (create_plan) with proposals the owner has not decided. */
export interface WaitingDraft {
  planId: number;
  plan: string;
  /** The drafting token's name ("Muse"). */
  agent: string;
  /** Its items still `proposed`. */
  proposed: number;
}

/**
 * `ownerId`'s plans drafted by an agent's token that hold proposals, oldest
 * first, as a scalar subquery: Today's card (#295) reads it beside the day
 * in one statement (todayFor's `drafts`), so the home screen's statement
 * count stays. A draft whose token was deleted (`drafted_by_token_id`
 * set null) has no agent to name and is left to the plans list.
 */
export function waitingDraftsSql(ownerId: number): SQL<WaitingDraft[]> {
  return sql<WaitingDraft[]>`(
    select coalesce(json_agg(json_build_object(
      'planId', ${wardrobePlan.id},
      'plan', ${wardrobePlan.name},
      'agent', ${personalAccessToken.name},
      'proposed', waiting.proposed
    ) order by ${wardrobePlan.id}), '[]')
    from ${wardrobePlan}
    join ${personalAccessToken}
      on ${personalAccessToken.id} = ${wardrobePlan.draftedByTokenId}
    cross join lateral (
      select count(*)::int as proposed from ${planItem}
      where ${planItem.planId} = ${wardrobePlan.id}
        and ${planItem.review} = 'proposed'
    ) waiting
    where ${wardrobePlan.ownerId} = ${ownerId} and waiting.proposed > 0)`;
}

/** The one writer of a style profile: the row upserted. */
export async function saveStyleProfile(
  db: Queryable,
  userId: number,
  fields: StyleProfileFields,
): Promise<void> {
  await db
    .insert(styleProfile)
    .values({ userId, ...fields })
    .onConflictDoUpdate({
      target: styleProfile.userId,
      set: { ...fields, updatedAt: sql`now()` },
    });
}
