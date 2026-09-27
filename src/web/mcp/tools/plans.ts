import * as z from 'zod/v4';
import { QUANTITY_MAX } from '../../../wardrobe/availability';
import {
  type ItemMatch,
  PLAN_PRIORITIES,
  targetDifferences,
} from '../../../wardrobe/plans';
import {
  categoryRole,
  FORMALITIES,
  GARMENT_COLORS,
  MATERIALS,
  WARMTHS,
} from '../../../wardrobe/properties';
import { HttpError } from '../../errors';
import {
  type CandidateGarment,
  type CandidatesByItem,
  candidatesOfPlan,
} from '../../plans/candidates';
import {
  allPlanGaps,
  type GapItem,
  planGaps,
  type PlanGaps,
  toTarget,
} from '../../plans/gaps';
import {
  findActivePlan,
  findOwnedItem,
  findPlan,
  findStyleProfile,
  insertItems,
  type PlanDetail,
  type PlanItemRow,
  updateItem,
} from '../../plans/queries';
import {
  BLANK_ITEM_VALUES,
  itemNotFound,
  ITEM_NAME_MAX,
  ITEM_NOTE_MAX,
  type PlanItemFormValues,
  planNotFound,
  readPlanItemForm,
  scaleText,
  storedItemValues,
} from '../../plans/validation';
import { CATEGORY_MAX } from '../../wardrobe/validation';
import { defineTool, type ToolContext } from '../tool';
import { rowId } from './common';

/**
 * The wardrobe plans' tools (#34, slice 34a): the owner's style profile,
 * their plans, and a plan's gaps as data, so their Claude can explain what
 * the wardrobe lacks and why ("the only grey merino is marked replace
 * soon"), and propose items. Plans and the profile are the caller's own,
 * like outfits: no ownerId, and a plan of anyone else's is "not found".
 *
 * The agent proposes; the owner decides. propose_plan_item adds an item
 * marked proposed, and update_plan_item leaves the item it changes marked
 * proposed again: a proposed item is shown apart on the gap view, left out
 * of the matching, until the owner accepts it (or saves it in the form) or
 * dismisses it. Items go through the plan item form's own reader
 * (readPlanItemForm), so the tools store exactly what the form would.
 *
 * get_plan_gaps also lists each item's candidate products (34b: wishlist
 * garments linked to it, each judged against the item); the shopping list,
 * adding a candidate and comparing plans are tools/shopping.ts's.
 */

const NO_ACTIVE_PLAN = 'No active plan: pass a planId from list_plans';

/** The caller's plan `planId`, or their active one when omitted. */
export async function planFor(
  ctx: ToolContext,
  planId: number | undefined,
): Promise<PlanDetail> {
  const plan =
    planId === undefined
      ? await findActivePlan(ctx.db, ctx.userId)
      : await findPlan(ctx.db, planId, ctx.userId);
  if (!plan) {
    throw planId === undefined
      ? new HttpError(404, NO_ACTIVE_PLAN)
      : planNotFound();
  }
  return plan;
}

export const planIdInput = rowId()
  .optional()
  .describe('A plan id from list_plans. Omit for your active plan.');

const Warmth = z.union(WARMTHS.map((w) => z.literal(w)));
const Formality = z.union(FORMALITIES.map((f) => z.literal(f)));

/**
 * An item's fields as the tools take them. Every field but the category is
 * optional and means "any" when absent (null clears it in an update).
 */
const ItemFields = {
  name: z
    .string()
    .max(ITEM_NAME_MAX)
    .nullable()
    .optional()
    .describe(
      'What to call it ("White heavyweight tee"); omit to describe it from its fields.',
    ),
  category: z
    .string()
    .min(1)
    .max(CATEGORY_MAX)
    .describe(
      'tops, bottoms, dresses, outerwear, footwear, accessories, bags, other, or a custom one.',
    ),
  type: z
    .string()
    .max(40)
    .nullable()
    .optional()
    .describe(
      'A type of the category (t-shirt, jeans, blazer...); omit for any.',
    ),
  colors: z
    .array(z.enum(GARMENT_COLORS))
    .max(GARMENT_COLORS.length)
    .optional()
    .describe('A garment needs every one of these; empty for any colour.'),
  materials: z
    .array(z.enum(MATERIALS))
    .max(MATERIALS.length)
    .optional()
    .describe('A garment needs every one of these; empty for any material.'),
  warmth: z
    .object({ min: Warmth, max: Warmth })
    .nullable()
    .optional()
    .describe(
      'Warmth 1 (very light) to 5 (very warm), both ends inclusive; null for any.',
    ),
  formality: z
    .object({ min: Formality, max: Formality })
    .nullable()
    .optional()
    .describe(
      'Formality 1 (lounge) to 4 (dressy), both ends inclusive; null for any.',
    ),
  quantity: z
    .number()
    .int()
    .min(1)
    .max(QUANTITY_MAX)
    .optional()
    .describe('Copies wanted (three white tees: 3). Default 1.'),
  priority: z.enum(PLAN_PRIORITIES).optional().describe('Default medium.'),
  budget: z
    .number()
    .nonnegative()
    .max(99_999_999)
    .nullable()
    .optional()
    .describe('What to spend on one, in US dollars.'),
  note: z
    .string()
    .max(ITEM_NOTE_MAX)
    .nullable()
    .optional()
    .describe('Why the wardrobe needs it: the owner reads it when deciding.'),
};

type ItemArgs = Partial<z.output<z.ZodObject<typeof ItemFields>>>;

/** `post(value)` when the argument was given; nothing (no keys) when not. */
function given<T, R extends Partial<PlanItemFormValues>>(
  value: T | undefined,
  post: (value: T) => R,
): R | Record<never, never> {
  return value === undefined ? {} : post(value);
}

/**
 * `args` over `base` as the item form would post them: only what was given
 * changes, and null clears a field.
 */
function itemPost(
  base: PlanItemFormValues,
  args: ItemArgs,
): PlanItemFormValues {
  return {
    ...base,
    ...given(args.name, (name) => ({ name: name ?? '' })),
    ...given(args.category, (category) => ({ category })),
    ...given(args.type, (type) => ({ type: type ?? '' })),
    ...given(args.colors, (colors) => ({ colors })),
    ...given(args.materials, (materials) => ({ materials })),
    // null clears a range: both ends.
    ...given(args.warmth, (warmth) => ({
      warmthMin: scaleText(warmth?.min ?? null),
      warmthMax: scaleText(warmth?.max ?? null),
    })),
    ...given(args.formality, (formality) => ({
      formalityMin: scaleText(formality?.min ?? null),
      formalityMax: scaleText(formality?.max ?? null),
    })),
    ...given(args.quantity, (quantity) => ({ quantity: String(quantity) })),
    ...given(args.priority, (priority) => ({ priority })),
    ...given(args.budget, (budget) => ({
      budget: budget === null ? '' : budget.toFixed(2),
    })),
    ...given(args.note, (note) => ({ note: note ?? '' })),
  };
}

/** The item form's reader, its messages as a refusal. */
function readItem(post: PlanItemFormValues) {
  const form = readPlanItemForm(post);
  if (!form.ok) {
    throw new HttpError(400, Object.values(form.errors).flat().join('. '));
  }
  return form.fields;
}

export function itemOut(item: PlanItemRow) {
  return {
    id: item.id,
    planId: item.planId,
    name: item.name,
    category: item.category,
    role: categoryRole(item.category),
    type: item.type,
    colors: item.colors ?? [],
    materials: item.materials ?? [],
    warmth:
      item.warmthMin === null
        ? null
        : { min: item.warmthMin, max: item.warmthMax },
    formality:
      item.formalityMin === null
        ? null
        : { min: item.formalityMin, max: item.formalityMax },
    quantity: item.quantity,
    priority: item.priority,
    budget: item.budget,
    note: item.note,
    proposed: item.proposed,
  };
}

/** Why an item is short, in a sentence the agent can pass on or reason from. */
function why(match: ItemMatch, gaps: PlanGaps): string | null {
  const named = (id: number) => {
    const garment = gaps.closet.get(id)!;
    return `${garment.name ?? garment.category} (garment ${id})`;
  };
  switch (match.reason) {
    case null:
      return null;
    case 'replace-soon':
      return `only replace_soon copies: ${match.replaceSoon.map(named).join(', ')} ${match.replaceSoon.length === 1 ? 'is' : 'are'} worn out and counted as the gap to refill`;
    case 'too-few-copies':
      return `${match.have} of ${match.need} copies owned`;
    case 'taken-by-other-items':
      return `what matches already fulfils other items: ${match.takenBy
        .map(
          (taker) =>
            `${named(taker.garmentId)} counts for item ${taker.itemId}`,
        )
        .join('; ')}`;
    case 'nothing-matches':
      return 'nothing in the closet matches';
  }
}

/**
 * A candidate product (34b) as the tools answer it: the wishlist garment,
 * its price and link, and whether it is the kind of thing `item` asks for
 * (and if not, how it differs: the property, what it has, what the item
 * wants).
 */
export function candidateOut(candidate: CandidateGarment, item: PlanItemRow) {
  const differences = targetDifferences(toTarget(item), candidate);
  return {
    garmentId: candidate.garmentId,
    name: candidate.name,
    brand: candidate.brand,
    category: candidate.category,
    type: candidate.type,
    colors: candidate.colors,
    price: candidate.price,
    sourceUrl: candidate.sourceUrl,
    matches: differences.length === 0,
    differences,
  };
}

function gapItemOut(
  { item, match }: GapItem,
  gaps: PlanGaps,
  candidates: CandidatesByItem,
) {
  const garment = (id: number) => gaps.closet.get(id)!;
  return {
    ...itemOut(item),
    status: match.status,
    have: match.have,
    need: match.need,
    fulfilledBy: match.fulfilledBy.map((fulfilment) => ({
      garmentId: fulfilment.garmentId,
      name: garment(fulfilment.garmentId).name,
      copies: fulfilment.copies,
      needsRepair: fulfilment.needsRepair,
    })),
    replaceSoon: match.replaceSoon.map((id) => ({
      garmentId: id,
      name: garment(id).name,
    })),
    takenBy: match.takenBy,
    reason: match.reason,
    why: why(match, gaps),
    candidates: (candidates.get(item.id) ?? []).map((candidate) =>
      candidateOut(candidate, item),
    ),
  };
}

function planOut(gaps: PlanGaps) {
  const { plan } = gaps;
  return {
    id: plan.id,
    name: plan.name,
    notes: plan.notes,
    active: plan.active,
    ...gaps.tally,
    proposed: gaps.proposed.length,
  };
}

export const planTools = [
  defineTool({
    name: 'get_style_profile',
    title: 'Get my style profile',
    description:
      "Your style profile: the styles you dress in, your budget band per piece (budget under $50, mid $50-150, premium $150-400, luxury above), your palette (garment colours), and your week's rhythm: how many times a week or a month each calendar occasion (work, workout, daytime, evening, night-out, all-day) comes round. Null when you never saved one. Your home city is the weather's (get_weather), not part of it.",
    input: z.object({}),
    writes: false,
    async run(_args, ctx) {
      return { profile: (await findStyleProfile(ctx.db, ctx.userId)) ?? null };
    },
  }),

  defineTool({
    name: 'list_plans',
    title: 'List my wardrobe plans',
    description:
      'Your wardrobe plans (the wardrobes you are building toward), the active one first: each with how many items your closet owns, partly owns and misses, and how many items proposed by an agent await your acceptance. get_plan_gaps has a plan in full.',
    input: z.object({}),
    writes: false,
    async run(_args, ctx) {
      const plans = await allPlanGaps(ctx.db, ctx.userId);
      return { plans: plans.map(planOut) };
    },
  }),

  defineTool({
    name: 'get_plan_gaps',
    title: 'Get a plan’s gaps',
    description:
      "A wardrobe plan measured against your closet (garments in it: not archived, not the wishlist): every item with its status (owned, partly, missing), copies had and needed, the garments that fulfil it, and for what is not owned the reason and a sentence why: replace-soon (only worn-out copies, marked replace_soon: the gap to refill), too-few-copies, taken-by-other-items (each garment fulfils one item), nothing-matches. A needs_repair garment still counts, flagged. A garment matches an item when it has the item's category, type if named, every colour and material named, and warmth and formality inside the item's ranges. Each item lists its candidate products: wishlist garments being considered for it, with price, link and whether each matches the item (and how not). Items proposed by an agent and not accepted are listed apart and not matched.",
    input: z.object({ planId: planIdInput }),
    writes: false,
    async run({ planId }, ctx) {
      const plan = await planFor(ctx, planId);
      const [gaps, candidates] = await Promise.all([
        planGaps(ctx.db, plan, ctx.userId),
        candidatesOfPlan(ctx.db, ctx.userId, plan.id),
      ]);
      const out = (entry: GapItem) => gapItemOut(entry, gaps, candidates);
      return {
        plan: planOut(gaps),
        missing: gaps.groups.missing.map(out),
        partly: gaps.groups.partly.map(out),
        owned: gaps.groups.owned.map(out),
        proposed: gaps.proposed.map((item) => ({
          ...itemOut(item),
          candidates: (candidates.get(item.id) ?? []).map((candidate) =>
            candidateOut(candidate, item),
          ),
        })),
      };
    },
  }),

  defineTool({
    name: 'propose_plan_item',
    title: 'Propose a plan item',
    description:
      'WRITES: adds an item to one of your wardrobe plans (the active one when planId is omitted), marked proposed: the owner sees it apart on the plan and accepts or dismisses it in the app; until then it is not part of the plan. An item is a target in the garment model’s own terms, not a product: category, optional type, colours, materials, warmth and formality ranges, quantity, priority, a budget and a note on why.',
    input: z.object({ planId: planIdInput, ...ItemFields }),
    writes: true,
    async run({ planId, ...args }, ctx) {
      const plan = await planFor(ctx, planId);
      const fields = readItem(itemPost(BLANK_ITEM_VALUES, args));
      const [id] = await insertItems(ctx.db, plan.id, [fields], {
        proposed: true,
      });
      ctx.webLogger.info(
        `Plan item ${id} proposed for plan ${plan.id} by user ${ctx.userId} (MCP)`,
      );
      return { id, planId: plan.id, proposed: true };
    },
  }),

  defineTool({
    name: 'update_plan_item',
    title: 'Update a plan item',
    description:
      'WRITES: changes an item of one of your wardrobe plans; fields not given stay as stored, null clears one. The changed item is marked proposed again: it leaves the plan’s matching until the owner accepts the change in the app. Use it to refine an item after talking it through, not to decide for the owner.',
    input: z.object({
      itemId: rowId().describe('The item id, from get_plan_gaps.'),
      ...ItemFields,
      category: ItemFields.category.optional(),
    }),
    writes: true,
    idempotent: true,
    async run({ itemId, ...args }, ctx) {
      const item = await findOwnedItem(ctx.db, itemId, ctx.userId);
      if (!item) throw itemNotFound();
      const fields = readItem(itemPost(storedItemValues(item), args));
      if (
        !(await updateItem(ctx.db, item.id, item.planId, ctx.userId, fields, {
          proposed: true,
        }))
      ) {
        throw itemNotFound();
      }
      ctx.webLogger.info(
        `Plan item ${item.id} of plan ${item.planId} changed by user ${ctx.userId} (MCP), proposed for acceptance`,
      );
      return { id: item.id, planId: item.planId, proposed: true };
    },
  }),
];
