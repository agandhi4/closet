import * as z from 'zod/v4';
import { fromCents } from '../../../wardrobe/shopping';
import { HttpError } from '../../errors';
import {
  candidatesOfItems,
  type CandidateResearch,
  changeCandidates,
  linkNewCandidate,
  MAX_CANDIDATES_PER_ITEM,
  requireCandidateRoom,
} from '../../plans/candidates';
import { planComparison, type ComparedRow } from '../../plans/compare';
import { allPlanGaps } from '../../plans/gaps';
import { findOwnedItem, type PlanItemRow } from '../../plans/queries';
import { planShoppingList } from '../../plans/shopping';
import { itemNotFound, planNotFound } from '../../plans/validation';
import { CATEGORY_MAX, NAME_MAX } from '../../wardrobe/validation';
import { garmentRef } from '../../wishlist/queries';
import { defineTool, type ToolContext, wardrobeFor } from '../tool';
import { candidateNoteInput, candidateRankInput, rowId } from './common';
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
 * rule puts what the agent adds to a plan itself (items) up for review. The
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
      'A wardrobe plan’s shopping list (your active plan unless planId is given): its missing and partly owned items, the highest priority first, each with how many copies are still to buy, its budget per piece, and its candidate products (wishlist garments linked to it, the likeliest first: your ranked picks by rank, then matching the item, within budget, cheapest), each with its price, link, your note and rank, whether it is within the budget and whether it matches the item (and how not). The totals: items, pieces, the budget over the items that have one, what the cheapest matching candidates would cost, and itemsWithoutPricedMatch: the items left out of that cost, having no candidate that both matches and has a price (none at all, or only unpriced or non-matching ones). Buying is the owner’s, in the app ("Bought it").',
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
          itemsWithoutPricedMatch: totals.withoutPricedMatch,
        },
      };
    },
  }),

  defineTool({
    name: 'add_candidate',
    title: 'Add a candidate product to a plan item',
    description: `WRITES: links a product to one of your plan items as a candidate, so it shows under the item on the shopping list. Either garmentId (an item already on your wishlist: list_wishlist) or url (a product page, imported onto your wishlist as add_garment_from_link does, then linked; rate limited with it, 10 a minute; name, category and type override the page). Not a proposal: a candidate changes nothing the plan asks for and counts for nothing until the owner buys it in the app. An item holds at most ${MAX_CANDIDATES_PER_ITEM} candidates (a few to choose between): past that the call is refused, so remove one in the app first. Give note (why it fits: material, fit and sizing, price against the budget, pairing with the closet) and rank (1 is your pick) so the owner sees your reasoning under each option; both are optional. A garment already a candidate of the item is refused when you give them: change its note and rank with update_candidate. Answers the garment and whether it matches the item (and how not).`,
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
      note: candidateNoteInput.optional(),
      rank: candidateRankInput.optional(),
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
      const research: CandidateResearch = {
        note: args.note ?? null,
        rank: args.rank ?? null,
      };
      const garmentId =
        args.url === undefined
          ? await linkWishlistItem(ctx, item.id, args.garmentId!, research)
          : await importCandidate(
              ctx,
              item.id,
              { ...args, url: args.url },
              research,
            );
      const candidate = await linkedCandidate(ctx, item, garmentId);
      ctx.webLogger.info(
        `Garment ${garmentId} added as a candidate for plan item ${item.id} by user ${ctx.userId} (MCP${args.url === undefined ? '' : ', from a link'}${research.note === null ? '' : ', with a note'}${research.rank === null ? '' : `, rank ${research.rank}`})`,
      );
      return { itemId: item.id, planId: item.planId, candidate };
    },
  }),

  defineTool({
    name: 'update_candidate',
    title: 'Change the note or rank of a candidate',
    description: `WRITES: changes your note and rank on a product that is a current candidate of one of your plan items (get_plan_gaps lists them): the note says why it fits, the rank (1 to ${MAX_CANDIDATES_PER_ITEM}, 1 your pick) puts it among the item's options; the owner sees the pick first and the notes under each option. Give note, rank or both; null clears one. Only a candidate still on the wishlist, on an item that is not declined; anything else is refused. Answers the candidate.`,
    input: z
      .object({
        itemId: rowId().describe('The plan item, from get_plan_gaps.'),
        garmentId: rowId().describe('Its candidate, from get_plan_gaps.'),
        note: candidateNoteInput.nullable().optional(),
        rank: candidateRankInput.nullable().optional(),
      })
      .refine((args) => args.note !== undefined || args.rank !== undefined, {
        message: 'Give a note, a rank or both',
      }),
    writes: true,
    idempotent: true,
    async run(args, ctx) {
      const item = await findOwnedItem(ctx.db, args.itemId, ctx.userId);
      if (!item) throw itemNotFound();
      const { updated } = await changeCandidates(ctx.db, ctx.userId, {
        update: [
          {
            itemId: item.id,
            garmentId: args.garmentId,
            note: args.note,
            rank: args.rank,
          },
        ],
      });
      if (updated === 0) {
        throw new HttpError(404, 'Not a current candidate of this plan item');
      }
      ctx.webLogger.info(
        `Candidate ${args.garmentId} of plan item ${item.id} updated by user ${ctx.userId} (MCP${args.note === undefined ? '' : args.note === null ? ', note cleared' : ', note'}${args.rank === undefined ? '' : `, rank ${args.rank ?? 'cleared'}`})`,
      );
      return {
        itemId: item.id,
        planId: item.planId,
        candidate: await linkedCandidate(ctx, item, args.garmentId),
      };
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
  research: CandidateResearch,
): Promise<number> {
  const garment = await garmentRef(ctx.db, garmentId, ctx.userId);
  if (!garment) throw new HttpError(404, 'Garment not found');
  if (garment.status !== 'wishlist') {
    throw new HttpError(409, 'Only a wishlist item can be a candidate');
  }
  const { added } = await changeCandidates(ctx.db, ctx.userId, {
    add: {
      itemIds: [itemId],
      garmentIds: [garment.id],
      research: new Map([[garment.id, research]]),
    },
  });
  // A link that was there keeps its research (the writer's rule): saying so
  // beats dropping the note the agent just wrote.
  if (added === 0 && (research.note !== null || research.rank !== null)) {
    throw new HttpError(
      409,
      'Already a candidate of this item: change its note and rank with update_candidate',
    );
  }
  return garment.id;
}

/**
 * add_candidate by url: the link import onto the caller's own wishlist, the
 * candidate link written in the garment's transaction (linkNewCandidate:
 * an item deleted while the page was fetched rolls the garment back).
 */
async function importCandidate(
  ctx: ToolContext,
  itemId: number,
  args: { url: string; name?: string; category?: string; type?: string },
  research: CandidateResearch,
): Promise<number> {
  const access = await wardrobeFor(ctx, undefined, 'manage');
  // Before the fetch: a full item would refuse the link anyway.
  await requireCandidateRoom(ctx.db, itemId);
  if (!(await ctx.allowLinkImport())) {
    throw new HttpError(429, 'Too many link imports: try again in a minute');
  }
  const saved = await addGarmentFromLink(
    ctx,
    access,
    {
      url: args.url,
      destination: 'wishlist',
      name: args.name,
      category: args.category,
      type: args.type,
    },
    {
      withGarment: (tx, garmentId) =>
        linkNewCandidate(tx, access.ownerId, itemId, garmentId, research),
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
