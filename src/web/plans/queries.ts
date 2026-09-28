import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Db, Queryable } from '../../db/client';
import {
  file,
  garment,
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
 * plan is active (setActivePlan; createPlan activates a first plan), the
 * items (addItems, insertItems, updateItem, acceptItem, deleteItem) and the style
 * profile (saveStyleProfile; its rhythm is the week template's, #16,
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
}

/** A stored plan item. */
export interface PlanItemRow extends PlanItemFields {
  id: number;
  planId: number;
  /** Written by the owner's agent and not accepted yet (matching leaves it out). */
  proposed: boolean;
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
  proposed: planItem.proposed,
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
 * A new plan of `ownerId`'s named by the owner (the plan form, the seed),
 * with `items`. 'name-taken' only for the name index (another of their
 * plans has the name in any case); any other violation is a bug and
 * rethrown. A savepoint, so a caller's transaction survives.
 */
export async function createPlan(
  db: Queryable,
  ownerId: number,
  fields: PlanFields,
  items: PlanItemFields[] = [],
): Promise<number | NameTaken> {
  try {
    return await ownerTransaction(db, ownerId, 'createPlan', (tx) =>
      insertPlan(tx, ownerId, fields, items),
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
 * active when the owner has no active plan yet (their first, or after
 * deleting the active one), so the gap view always has one to show once
 * any exists; the lock makes that check and the activation one step.
 */
async function insertPlan(
  tx: Queryable,
  ownerId: number,
  fields: PlanFields,
  items: PlanItemFields[],
): Promise<number> {
  // Decided in the insert itself: the subquery reads the owner's plans as
  // they were before this row, and the owner lock keeps them so.
  const [row] = await tx
    .insert(wardrobePlan)
    .values({
      ownerId,
      ...fields,
      active: sql`not exists (select 1 from ${wardrobePlan} where ${wardrobePlan.ownerId} = ${ownerId} and ${wardrobePlan.active})`,
    })
    .returning({ id: wardrobePlan.id });
  await insertItems(tx, row.id, items, { proposed: false });
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
  options: { proposed: boolean },
): Promise<number[] | undefined> {
  return ownerTransaction(db, ownerId, 'addItems', async (tx) =>
    (await findPlan(tx, planId, ownerId))
      ? insertItems(tx, planId, items, options)
      : undefined,
  );
}

/**
 * Inserts items into plan `planId`, which the caller found to be the
 * owner's under the owner lock it holds (createPlan, the duplicate, the
 * seed; addItems for everyone else); their ids in `items`' order (a
 * duplicate maps each original to its copy).
 */
export async function insertItems(
  db: Queryable,
  planId: number,
  items: PlanItemFields[],
  { proposed }: { proposed: boolean },
): Promise<number[]> {
  if (items.length === 0) return [];
  const rows = await db
    .insert(planItem)
    .values(items.map((item) => ({ ...item, planId, proposed })))
    .returning({ id: planItem.id });
  // One statement draws its serials in VALUES order; RETURNING's own order
  // is not promised, so the ids are put back in that order.
  return rows.map((row) => row.id).sort((a, b) => a - b);
}

/** The owner's plan `planId` exists: the item writers' guard. */
function ownsPlan(planId: number, ownerId: number) {
  return sql`${planItem.planId} in (select ${wardrobePlan.id} from ${wardrobePlan} where ${wardrobePlan.id} = ${planId} and ${wardrobePlan.ownerId} = ${ownerId})`;
}

/**
 * Rewrites item `itemId` of the owner's plan `planId` whole. `proposed`
 * says who wrote it: the owner's form accepts it (false), the agent's
 * update_plan_item leaves it for the owner to accept (true). False when
 * not the owner's.
 */
export async function updateItem(
  db: Queryable,
  itemId: number,
  planId: number,
  ownerId: number,
  fields: PlanItemFields,
  { proposed }: { proposed: boolean },
): Promise<boolean> {
  const updated = await ownerTransaction(db, ownerId, 'updateItem', (tx) =>
    tx
      .update(planItem)
      .set({ ...fields, proposed })
      .where(and(eq(planItem.id, itemId), ownsPlan(planId, ownerId)))
      .returning({ id: planItem.id }),
  );
  return updated.length > 0;
}

/** The owner accepts what their agent proposed: it joins the plan's matching. */
export async function acceptItem(
  db: Db,
  itemId: number,
  planId: number,
  ownerId: number,
): Promise<boolean> {
  const updated = await ownerTransaction(db, ownerId, 'acceptItem', (tx) =>
    tx
      .update(planItem)
      .set({ proposed: false })
      .where(and(eq(planItem.id, itemId), ownsPlan(planId, ownerId)))
      .returning({ id: planItem.id }),
  );
  return updated.length > 0;
}

/** Deletes it (a proposal dismissed, an item dropped); false when not the owner's. */
export async function deleteItem(
  db: Db,
  itemId: number,
  planId: number,
  ownerId: number,
): Promise<boolean> {
  const deleted = await ownerTransaction(db, ownerId, 'deleteItem', (tx) =>
    tx
      .delete(planItem)
      .where(and(eq(planItem.id, itemId), ownsPlan(planId, ownerId)))
      .returning({ id: planItem.id }),
  );
  return deleted.length > 0;
}

// ---- The style profile ------------------------------------------------------

/** The user's style profile, or undefined when never saved. */
export async function findStyleProfile(
  db: Db,
  userId: number,
): Promise<StyleProfileFields | undefined> {
  const [row] = await db
    .select({
      styles: styleProfile.styles,
      budget: styleProfile.budget,
      palette: styleProfile.palette,
      notes: styleProfile.notes,
    })
    .from(styleProfile)
    .where(eq(styleProfile.userId, userId));
  return row;
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
