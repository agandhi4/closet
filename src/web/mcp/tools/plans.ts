import * as z from 'zod/v4';
import { selectScalars } from '../../../db/select-scalars';
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
import { t } from '../../i18n';
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
  addItems,
  createPlan,
  findActivePlan,
  findOwnedItem,
  findPlan,
  type PlanDetail,
  type PlanItemRow,
  styleProfileSql,
  updateItem,
} from '../../plans/queries';
import { type Rejection, rejectionsOfPlan } from '../../plans/rejections';
import { templateDays, weeklyRhythm } from '../../../wardrobe/week';
import { inTemplateOrder, weekTemplateSql } from '../../week-plan/template';
import {
  BLANK_ITEM_VALUES,
  itemNotFound,
  ITEM_NAME_MAX,
  ITEM_NOTE_MAX,
  PLAN_NAME_MAX,
  PLAN_NOTES_MAX,
  type PlanItemFormValues,
  planNotFound,
  readPlanForm,
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
 * The agent proposes; the owner decides. create_plan drafts a plan of the
 * agent's own (#269), never active and marked with the calling token, so
 * its work stays apart from the plan the owner keeps; propose_plan_item
 * adds an item at review `proposed`, and update_plan_item puts an item the
 * owner sent back (`revise`) or had accepted back to `proposed` (the
 * review machine, src/wardrobe/plan-review.ts, #278); a declined item it
 * refuses (409). Only accepted items are matched. Items go through the
 * plan item form's own reader (readPlanItemForm), so the tools store
 * exactly what the form would.
 *
 * get_plan_gaps also lists each item's review, the owner's note, its
 * candidate products (34b: wishlist garments linked to it, each judged
 * against the item) and the products the owner rejected for it ("Not this
 * one", with the reason); the shopping list, adding a candidate and
 * comparing plans are tools/shopping.ts's.
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
  .describe(
    'A plan id from list_plans or create_plan. Omit for your active plan.',
  );

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
    review: item.review,
    ownerNote: item.ownerNote,
  };
}

/** The products the owner turned down for an item, as the agent reads them. */
function rejectedOut(rejections: ReadonlyMap<number, Rejection[]>, id: number) {
  return (rejections.get(id) ?? []).map((rejection) => ({
    name: rejection.name,
    brand: rejection.brand,
    url: rejection.url,
    price: rejection.price,
    reason: rejection.reason,
    at: rejection.at.toISOString(),
  }));
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
    case 'replace-soon': {
      // Partly owned too: the usable copies count, the worn-out ones do not.
      const owned =
        match.have > 0
          ? `${match.have} of ${match.need} copies owned`
          : 'no usable copy owned';
      return `${owned}; ${match.replaceSoon.map(named).join(', ')} ${match.replaceSoon.length === 1 ? 'is' : 'are'} marked replace_soon (worn out) and counted as the gap to refill`;
    }
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

/** An item's candidates and rejected products: every get_plan_gaps item carries them. */
function productsOut(
  item: PlanItemRow,
  candidates: CandidatesByItem,
  rejections: ReadonlyMap<number, Rejection[]>,
) {
  return {
    candidates: (candidates.get(item.id) ?? []).map((candidate) =>
      candidateOut(candidate, item),
    ),
    rejected: rejectedOut(rejections, item.id),
  };
}

function gapItemOut(
  { item, match }: GapItem,
  gaps: PlanGaps,
  candidates: CandidatesByItem,
  rejections: ReadonlyMap<number, Rejection[]>,
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
    ...productsOut(item, candidates, rejections),
  };
}

function planOut(gaps: PlanGaps) {
  const { plan } = gaps;
  return {
    id: plan.id,
    name: plan.name,
    notes: plan.notes,
    active: plan.active,
    draftedBy: plan.draftedBy,
    ...gaps.tally,
    proposed: gaps.review.proposed.length,
    revise: gaps.review.revise.length,
    declined: gaps.review.declined.length,
  };
}

export const planTools = [
  defineTool({
    name: 'get_style_profile',
    title: 'Get my style profile',
    description:
      "Your style profile: the styles you dress in, your budget band per piece (budget under $50, mid $50-150, premium $150-400, luxury above) and your palette (garment colours); null when you never saved one. And your week: the week template (Sunday first, weekday 0 to 6: the occasion of the day's outfit, all-day, work or daytime, or none, and the occasions around it, workout, evening, night-out) that plan_week fills, and the rhythm derived from it (how many days a week each occasion comes round). Your home city is the weather's (get_weather), not part of it.",
    input: z.object({}),
    writes: false,
    async run(_args, ctx) {
      // One statement (#172; it was two).
      const read = await selectScalars(ctx.db, {
        profile: styleProfileSql(ctx.userId),
        template: weekTemplateSql(ctx.userId),
      });
      const template = inTemplateOrder(read.template);
      return {
        profile: read.profile,
        week: {
          template: templateDays(template),
          rhythm: weeklyRhythm(template),
        },
      };
    },
  }),

  defineTool({
    name: 'list_plans',
    title: 'List my wardrobe plans',
    description:
      'Your wardrobe plans (the wardrobes you are building toward), the active one first: each with how many items your closet owns, partly owns and misses, how many items proposed by an agent await your review, how many you sent back for a change (revise) and how many you declined. get_plan_gaps has a plan in full.',
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
      "A wardrobe plan measured against your closet (garments in it: not archived, not the wishlist): every item with its status (owned, partly, missing), copies had and needed, the garments that fulfil it, and for what is not owned the reason and a sentence why: replace-soon (matching copies marked replace_soon are worn out: the gap to refill; usable copies beside them still count, so the item may be partly owned), too-few-copies, taken-by-other-items (each garment fulfils one item), nothing-matches. A needs_repair garment still counts, flagged. A garment matches an item when it has the item's category, type if named, every colour and material named, and warmth and formality inside the item's ranges. Every item has its review: accepted (part of the plan, the only items matched), proposed (by an agent, awaiting the owner), revise (the owner asked for a change: ownerNote says what; change it with update_plan_item) or declined (the owner does not want it: ownerNote may say why; never propose it again). Items not accepted are listed apart (proposed, revise, declined) and not matched. Each item lists its candidate products (wishlist garments being considered for it, with price, link and whether each matches the item, and how not) and the products the owner rejected for it (rejected: name, brand, url, price, reason, when; never add one again).",
    input: z.object({ planId: planIdInput }),
    writes: false,
    async run({ planId }, ctx) {
      const plan = await planFor(ctx, planId);
      const [gaps, candidates, rejections] = await Promise.all([
        planGaps(ctx.db, plan, ctx.userId),
        candidatesOfPlan(ctx.db, ctx.userId, plan.id),
        rejectionsOfPlan(ctx.db, plan.id),
      ]);
      const out = (entry: GapItem) =>
        gapItemOut(entry, gaps, candidates, rejections);
      const apart = (item: PlanItemRow) => ({
        ...itemOut(item),
        ...productsOut(item, candidates, rejections),
      });
      return {
        plan: planOut(gaps),
        missing: gaps.groups.missing.map(out),
        partly: gaps.groups.partly.map(out),
        owned: gaps.groups.owned.map(out),
        proposed: gaps.review.proposed.map(apart),
        revise: gaps.review.revise.map(apart),
        declined: gaps.review.declined.map(apart),
      };
    },
  }),

  defineTool({
    name: 'create_plan',
    title: 'Draft a wardrobe plan',
    description:
      'WRITES: creates a wardrobe plan of your own to propose items into, marked as drafted by this connection (the owner sees its name on the plan) and never active: the owner decides whether it becomes the plan they keep. name must be one none of their plans has (any case); notes is your rationale (the brief, the style read, what the plan is for), shown on the plan. Then propose_plan_item with its id.',
    input: z.object({
      name: z
        .string()
        .min(1)
        .max(PLAN_NAME_MAX)
        .describe('The plan’s name ("Muse: spring capsule").'),
      notes: z
        .string()
        .max(PLAN_NOTES_MAX)
        .optional()
        .describe('Why this plan: the owner reads it on the plan’s page.'),
    }),
    writes: true,
    async run({ name, notes }, ctx) {
      // The plan form's own reader: trimmed, never blank, empty notes null.
      const form = readPlanForm({ name, notes });
      if (!form.ok) {
        throw new HttpError(400, Object.values(form.errors).flat().join('. '));
      }
      const id = await createPlan(ctx.db, ctx.userId, form.fields, [], {
        draftedByTokenId: ctx.tokenId,
      });
      if (id === 'name-taken') {
        throw new HttpError(409, t('validation.PLAN_NAME_TAKEN'));
      }
      ctx.webLogger.info(
        `Plan ${id} drafted for user ${ctx.userId} by token ${ctx.tokenId} (MCP)`,
      );
      return { id, name: form.fields.name, active: false };
    },
  }),

  defineTool({
    name: 'propose_plan_item',
    title: 'Propose a plan item',
    description:
      'WRITES: adds an item to one of your wardrobe plans (the active one when planId is omitted), at review proposed: the owner sees it apart on the plan and accepts it, asks for a change or declines it in the app; until accepted it is not part of the plan. Never propose again an item the owner declined (get_plan_gaps lists them). An item is a target in the garment model’s own terms, not a product: category, optional type, colours, materials, warmth and formality ranges, quantity, priority, a budget and a note on why.',
    input: z.object({ planId: planIdInput, ...ItemFields }),
    writes: true,
    async run({ planId, ...args }, ctx) {
      const plan = await planFor(ctx, planId);
      const fields = readItem(itemPost(BLANK_ITEM_VALUES, args));
      const added = await addItems(ctx.db, ctx.userId, plan.id, [fields], {
        review: 'proposed',
      });
      if (!added) throw planNotFound();
      const [id] = added;
      ctx.webLogger.info(
        `Plan item ${id} proposed for plan ${plan.id} by user ${ctx.userId} (MCP)`,
      );
      return { id, planId: plan.id, review: 'proposed' as const };
    },
  }),

  defineTool({
    name: 'update_plan_item',
    title: 'Update a plan item',
    description:
      'WRITES: changes an item of one of your wardrobe plans; fields not given stay as stored, null clears one. The changed item is at review proposed again (an item the owner sent back for a change, review revise, goes back to them this way; their ownerNote stays for them to compare): it leaves the plan’s matching until the owner accepts the change in the app. An item the owner declined is refused (409). Use it to refine an item after talking it through, not to decide for the owner.',
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
      const updated = await updateItem(
        ctx.db,
        item.id,
        item.planId,
        ctx.userId,
        fields,
        'agent',
      );
      if (!updated.ok) {
        if (updated.reason === 'not-found') throw itemNotFound();
        ctx.webLogger.warn(
          `Plan item ${item.id} of plan ${item.planId}: update by user ${ctx.userId} (MCP) refused, the item is ${updated.review}`,
        );
        throw new HttpError(
          409,
          'The owner declined this item: do not propose it again',
        );
      }
      ctx.webLogger.info(
        `Plan item ${item.id} of plan ${item.planId} changed by user ${ctx.userId} (MCP), ${updated.from} to ${updated.to}`,
      );
      return { id: item.id, planId: item.planId, review: updated.to };
    },
  }),
];
