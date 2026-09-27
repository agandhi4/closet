import * as z from 'zod/v4';
import { fromCents } from '../../../wardrobe/shopping';
import { HttpError } from '../../errors';
import { candidatesOfItems, changeCandidates } from '../../plans/candidates';
import { planComparison, type ComparedRow } from '../../plans/compare';
import { allPlanGaps } from '../../plans/gaps';
import { findOwnedItem, type PlanItemRow } from '../../plans/queries';
import { planShoppingList } from '../../plans/shopping';
import { itemNotFound, planNotFound } from '../../plans/validation';
import { CATEGORY_MAX, NAME_MAX } from '../../wardrobe/validation';
import { garmentRef } from '../../wishlist/queries';
import { defineTool, type ToolContext, wardrobeFor } from '../tool';
import { rowId } from './common';
import { addGarmentFromLink } from './link-import';
import { candidateOut, itemOut, planFor, planIdInput } from './plans';

/**
 * The shopping loop's tools (#34, slice 34b): a plan's shopping list, adding
 * a candidate product to an item, and comparing two plans. The caller's own
 * plans, like tools/plans.ts's: no ownerId.
 *
 * A candidate link is not a proposal: it adds a product to consider, never
 * changes what the plan is, and never counts toward it (matching reads the
 * closet), so add_candidate writes it as the owner's form would, where 34a's
 * rule marks what the agent adds to a plan itself (items) as proposed. The
 * owner decides by buying one ("Bought it") or removing it from the item.
 */

/** A comparison row as compare_plans answers it. */
function comparedOut(row: ComparedRow) {
  return { ...itemOut(row.row), status: row.status };
}

export const shoppingTools = [
  defineTool({
    name: 'get_shopping_list',
    title: 'Get my shopping list',
    description:
      'A wardrobe plan’s shopping list (your active plan unless planId is given): its missing and partly owned items, the highest priority first, each with how many copies are still to buy, its budget per piece, and its candidate products (wishlist garments linked to it, the likeliest first: matching the item, within budget, cheapest), each with its price, link, whether it is within the budget and whether it matches the item (and how not). The totals: items, pieces, the budget over the items that have one, and what the cheapest matching candidates would cost. Buying is the owner’s, in the app ("Bought it").',
    input: z.object({ planId: planIdInput }),
    writes: false,
    async run({ planId }, ctx) {
      const plan = await planFor(ctx, planId);
      const list = await planShoppingList(ctx.db, plan, ctx.userId);
      const { totals } = list;
      return {
        plan: { id: plan.id, name: plan.name, active: plan.active },
        items: list.entries.map(({ item, match, toBuy, candidates }) => ({
          ...itemOut(item),
          status: match.status,
          have: match.have,
          need: match.need,
          toBuy,
          candidates: candidates.map(({ candidate, budget }) => ({
            ...candidateOut(candidate, item),
            budget,
          })),
        })),
        totals: {
          items: totals.items,
          pieces: totals.pieces,
          budget: fromCents(totals.budgetCents),
          itemsWithoutBudget: totals.unbudgeted,
          cheapestCandidates: fromCents(totals.cheapestCents),
          itemsWithoutCandidate: totals.uncovered,
        },
      };
    },
  }),

  defineTool({
    name: 'add_candidate',
    title: 'Add a candidate product to a plan item',
    description:
      'WRITES: links a product to one of your plan items as a candidate, so it shows under the item on the shopping list. Either garmentId (an item already on your wishlist: list_wishlist) or url (a product page, imported onto your wishlist as add_garment_from_link does, then linked; rate limited with it, 10 a minute; name, category and type override the page). Not a proposal: a candidate changes nothing the plan asks for and counts for nothing until the owner buys it in the app. Answers the garment and whether it matches the item (and how not).',
    input: z.object({
      itemId: rowId().describe('The plan item, from get_plan_gaps.'),
      garmentId: rowId()
        .optional()
        .describe('A wishlist item of yours. Give this or url.'),
      url: z
        .url({ protocol: /^https?$/ })
        .max(2048)
        .optional()
        .describe(
          'A product page to add to your wishlist. Give this or garmentId.',
        ),
      name: z.string().max(NAME_MAX).optional(),
      category: z.string().max(CATEGORY_MAX).optional(),
      type: z.string().max(40).optional(),
    }),
    writes: true,
    idempotent: false,
    openWorld: true,
    async run(args, ctx) {
      if ((args.garmentId === undefined) === (args.url === undefined)) {
        throw new HttpError(400, 'Give either garmentId or url');
      }
      const item = await findOwnedItem(ctx.db, args.itemId, ctx.userId);
      if (!item) throw itemNotFound();
      const garmentId =
        args.url === undefined
          ? await linkWishlistItem(ctx, item.id, args.garmentId!)
          : await importCandidate(ctx, item.id, { ...args, url: args.url });
      const candidate = await linkedCandidate(ctx, item, garmentId);
      ctx.webLogger.info(
        `Garment ${garmentId} added as a candidate for plan item ${item.id} by user ${ctx.userId} (MCP${args.url === undefined ? '' : ', from a link'})`,
      );
      return { itemId: item.id, planId: item.planId, candidate };
    },
  }),

  defineTool({
    name: 'compare_plans',
    title: 'Compare two plans',
    description:
      'Two of your wardrobe plans side by side, by item: items are the same when they are the same kind of thing (category, type and colour set). Answers what b adds (only in b), what it drops (only in a), and what both have, each pair with what changed (quantity, priority, details: materials, warmth or formality); every item with its status (owned, partly, missing) in its own plan. Proposals are left out.',
    input: z.object({
      a: rowId().describe('A plan id from list_plans.'),
      b: rowId().describe('The plan to compare it with.'),
    }),
    writes: false,
    async run({ a, b }, ctx) {
      const all = await allPlanGaps(ctx.db, ctx.userId);
      const pick = (id: number) => {
        const gaps = all.find((g) => g.plan.id === id);
        if (!gaps) throw planNotFound();
        return gaps;
      };
      const [left, right] = [pick(a), pick(b)];
      const comparison = planComparison(left, right);
      return {
        a: { id: left.plan.id, name: left.plan.name },
        b: { id: right.plan.id, name: right.plan.name },
        added: comparison.added.map(comparedOut),
        dropped: comparison.dropped.map(comparedOut),
        both: comparison.both.map((pair) => ({
          a: comparedOut(pair.a),
          b: comparedOut(pair.b),
          changes: pair.changes,
        })),
      };
    },
  }),
];

/**
 * add_candidate by garmentId: the caller's own wishlist item, linked (the
 * writer drops anything else; these are its refusals in words).
 */
async function linkWishlistItem(
  ctx: ToolContext,
  itemId: number,
  garmentId: number,
): Promise<number> {
  const garment = await garmentRef(ctx.db, garmentId, ctx.userId);
  if (!garment) throw new HttpError(404, 'Garment not found');
  if (garment.status !== 'wishlist') {
    throw new HttpError(409, 'Only a wishlist item can be a candidate');
  }
  await changeCandidates(ctx.db, ctx.userId, {
    add: { itemIds: [itemId], garmentIds: [garment.id] },
  });
  return garment.id;
}

/**
 * add_candidate by url: the link import onto the caller's own wishlist, the
 * candidate link written in the garment's transaction.
 */
async function importCandidate(
  ctx: ToolContext,
  itemId: number,
  args: { url: string; name?: string; category?: string; type?: string },
): Promise<number> {
  const access = await wardrobeFor(ctx, undefined, 'manage');
  if (!(await ctx.allowLinkImport())) {
    throw new HttpError(429, 'Too many link imports: try again in a minute');
  }
  const saved = await addGarmentFromLink(
    ctx,
    access.ownerId,
    {
      url: args.url,
      destination: 'wishlist',
      name: args.name,
      category: args.category,
      type: args.type,
    },
    {
      withGarment: (tx, garmentId) =>
        changeCandidates(tx, access.ownerId, {
          add: { itemIds: [itemId], garmentIds: [garmentId] },
        }),
    },
  );
  return saved.id;
}

/**
 * The new candidate as the shopping list shows it: the garment and how it
 * fits `item`. Missing only when the item went meanwhile (the link cascaded).
 */
async function linkedCandidate(
  ctx: ToolContext,
  item: PlanItemRow,
  garmentId: number,
) {
  const candidate = (await candidatesOfItems(ctx.db, ctx.userId, [item.id]))
    .get(item.id)
    ?.find((c) => c.garmentId === garmentId);
  if (!candidate) throw itemNotFound();
  return candidateOut(candidate, item);
}
