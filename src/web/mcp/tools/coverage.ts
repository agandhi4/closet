import * as z from 'zod/v4';
import { QUANTITY_MAX } from '../../../wardrobe/availability';
import {
  matchPlan,
  PLAN_PRIORITIES,
  type PlanTarget,
  type Range,
} from '../../../wardrobe/plans';
import {
  FORMALITIES,
  GARMENT_COLORS,
  MATERIALS,
  WARMTHS,
} from '../../../wardrobe/properties';
import { HttpError } from '../../errors';
import { closetPieces } from '../../plans/queries';
import { normalizeCategory } from '../../wardrobe/garment';
import { CATEGORY_MAX } from '../../wardrobe/validation';
import { defineTool } from '../tool';
import { checkedType } from './garments';

/**
 * get_closet_coverage (#337; doc section 5): what the closet lacks,
 * derived on every call and never stored. The agent states its targets in
 * the garment model's terms; matchPlan (the plans' gap analysis, pure,
 * src/wardrobe/plans.ts) judges them against closetPieces, as a plan's
 * gap view did, so the two never disagree. Both move out of the plans'
 * modules when plans go (#337 part B). The caller's own closet.
 */

/** Targets one call may judge: a wardrobe's worth. */
const COVERAGE_TARGETS_MAX = 40;

const Warmth = z.union(WARMTHS.map((w) => z.literal(w)));
const Formality = z.union(FORMALITIES.map((f) => z.literal(f)));

/** A range as matching reads it; one upside down is the caller's mistake. */
function rangeOf<T extends number>(
  property: string,
  range: Range<T>,
): Range<T> {
  if (range.min > range.max) {
    throw new HttpError(400, `${property}: min is above max`);
  }
  return range;
}

export const coverageTools = [
  defineTool({
    name: 'get_closet_coverage',
    title: 'Check what the closet covers',
    description:
      'Judges targets you describe ("a navy wool blazer, formality 3 to 4") against the owner\'s closet, derived now and never stored: each target owned, partly (too few copies) or missing, the garments that fulfil it (closest first; needs_repair counts, flagged), the matching ones marked replace_soon (worn out: the gap to refill, not a fulfilment), and why it is not owned (replace-soon, too-few-copies, taken-by-other-items, nothing-matches). One garment fulfils one target, with all its copies, so overlapping targets share nothing. Propose needs only for what is missing or partly owned.',
    input: z.object({
      targets: z
        .array(
          z.object({
            category: z
              .string()
              .trim()
              .min(1)
              .max(CATEGORY_MAX)
              .describe(
                'tops, bottoms, dresses, outerwear, footwear, accessories, bags, other, or a custom one.',
              ),
            type: z
              .string()
              .max(40)
              .optional()
              .describe('A type of the category (t-shirt, jeans, blazer...).'),
            colors: z
              .array(z.enum(GARMENT_COLORS))
              .optional()
              .describe('A garment needs every one of these.'),
            materials: z
              .array(z.enum(MATERIALS))
              .optional()
              .describe('A garment needs every one of these.'),
            warmth: z
              .object({ min: Warmth, max: Warmth })
              .optional()
              .describe('1 (very light) to 5 (very warm), both inclusive.'),
            formality: z
              .object({ min: Formality, max: Formality })
              .optional()
              .describe('1 (lounge) to 4 (dressy), both inclusive.'),
            quantity: z
              .number()
              .int()
              .min(1)
              .max(QUANTITY_MAX)
              .optional()
              .describe('Copies wanted. Default 1.'),
            priority: z
              .enum(PLAN_PRIORITIES)
              .optional()
              .describe(
                'Which target chooses first when garments could fulfil several. Default medium.',
              ),
          }),
        )
        .min(1)
        .max(COVERAGE_TARGETS_MAX),
    }),
    writes: false,
    async run({ targets }, ctx) {
      const asked = targets.map((target, index): PlanTarget => {
        const category = normalizeCategory(target.category);
        return {
          id: index + 1,
          category,
          type: target.type ? checkedType(category, target.type) : null,
          colors: target.colors ?? [],
          materials: target.materials ?? [],
          warmth: target.warmth ? rangeOf('warmth', target.warmth) : null,
          formality: target.formality
            ? rangeOf('formality', target.formality)
            : null,
          quantity: target.quantity ?? 1,
          priority: target.priority ?? 'medium',
        };
      });
      const closet = await closetPieces(ctx.db, ctx.userId);
      const names = new Map(closet.map((g) => [g.id, g.name]));
      const named = (id: number) => ({ id, name: names.get(id) ?? null });
      return {
        targets: matchPlan(asked, closet).map((match) => ({
          target: match.itemId - 1,
          status: match.status,
          have: match.have,
          need: match.need,
          fulfilledBy: match.fulfilledBy.map((f) => ({
            ...named(f.garmentId),
            copies: f.copies,
            needsRepair: f.needsRepair,
          })),
          replaceSoon: match.replaceSoon.map(named),
          takenBy: match.takenBy.map((taken) => ({
            ...named(taken.garmentId),
            target: taken.itemId - 1,
          })),
          reason: match.reason,
        })),
      };
    },
  }),
];
