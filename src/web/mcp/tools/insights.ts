import * as z from 'zod/v4';
import {
  BRANDS_LIMIT,
  type Breakdown,
  type CostPerWear,
  DEFAULT_UNWORN_DAYS,
  type InsightGarment,
  LEAST_WORN_MIN_OWNED_DAYS,
  PAIR_MIN_DAYS,
  RECENT_DAYS,
  UNWORN_CHOICES,
  UNWORN_SHOWN,
} from '../../../wardrobe/insights';
import { todayIn } from '../../../calendar-date';
import { readInsights } from '../../insights/queries';
import { defineTool } from '../tool';

/**
 * Insights as data (#17): the same figures as /wardrobe/insights, from the
 * same readInsights, for the caller's own closet (wears are the owner's
 * records: no ownerId). Money is in dollars as decimal strings, as the
 * other tools give prices.
 */

function garmentOut(g: InsightGarment) {
  return {
    id: g.id,
    name: g.name,
    category: g.category,
    brand: g.brand,
    quantity: g.quantity,
    wearDays: g.wearDays,
    lastWorn: g.lastWorn,
    daysSinceWorn: g.daysSinceWorn,
  };
}

function costOut(entry: CostPerWear) {
  return {
    ...garmentOut(entry.garment),
    price: entry.garment.price,
    repairCost: entry.garment.repairCost,
    cost: entry.cost,
    costPerWear: entry.perWear,
  };
}

function breakdownOut(row: Breakdown, keyName: 'category' | 'brand') {
  return {
    [keyName]: row.key,
    garments: row.garments,
    pieces: row.pieces,
    recentWearDays: row.recentWearDays,
    closetPercent: row.closet,
    wornPercent: row.worn,
  };
}

const UnwornDays = z.union(UNWORN_CHOICES.map((days) => z.literal(days)));

export const insightTools = [
  defineTool({
    name: 'wardrobe_stats',
    title: 'Wardrobe stats',
    description: `How your closet is actually used (garments in it: not archived, not the wishlist), from your wear log; the insights page's figures. Wears are distinct days (two outfits on one day holding a garment are one wear), and a garment with several identical copies is one garment. worn: the share of the closet worn in the last 30, 90 and 365 days (today included). unworn: garments not worn in unwornDays (${UNWORN_CHOICES.join(', ')}; default ${DEFAULT_UNWORN_DAYS}) among those owned that long (or without an acquired date), never worn first, at most ${UNWORN_SHOWN} listed with the whole count. mostWorn and leastWorn: by wear days ever; least only among garments owned ${LEAST_WORN_MIN_OWNED_DAYS} days or more. costPerWear: cost is price per piece × copies (the price paid, which "Bought it" records) plus repairCost, what its repairs cost (null for none), divided by wear days; null when not worn yet (listed apart); a garment without a price is left out, repaired or not; best (lowest) and worst (highest), the closet's total cost (repairs included) and how many garments lack a price. pairs: garments worn on the same days most often in the last ${RECENT_DAYS} days (at least ${PAIR_MIN_DAYS} days). colours, categories and brands: each one's share of the closet's garments and of the last ${RECENT_DAYS} days' wears (a garment in two colours counts half to each); brands are grouped regardless of case, the first ${BRANDS_LIMIT} by garments named and the rest summed as brand null. condition: garments marked needs_repair and replace_soon. Your own closet only.`,
    input: z.object({
      unwornDays: UnwornDays.optional().describe(
        `The unworn list's window in days: ${UNWORN_CHOICES.join(', ')}.`,
      ),
    }),
    writes: false,
    async run({ unwornDays }, ctx) {
      const today = todayIn(ctx.timeZone, new Date());
      const insights = await readInsights(
        ctx.db,
        ctx.userId,
        today,
        unwornDays ?? DEFAULT_UNWORN_DAYS,
      );
      const { cost } = insights;
      return {
        today,
        closet: insights.closet,
        worn: insights.worn,
        unworn: {
          days: insights.unworn.days,
          count: insights.unworn.garments.length,
          garments: insights.unworn.garments
            .slice(0, UNWORN_SHOWN)
            .map(garmentOut),
        },
        mostWorn: insights.mostWorn.map(garmentOut),
        leastWorn: insights.leastWorn.map(garmentOut),
        costPerWear: {
          best: cost.best.map(costOut),
          worst: cost.worst.map(costOut),
          notWornYet: cost.notWornYet.map(costOut),
          notWornYetCount: cost.notWornYetCount,
          closetValue: cost.closetValue,
          priced: cost.priced,
          unpriced: cost.unpriced,
        },
        pairs: insights.pairs.map(({ a, b, days }) => ({
          garments: [garmentOut(a), garmentOut(b)],
          days,
        })),
        colours: insights.colours.map((c) => ({
          colour: c.colour,
          closetPercent: c.closet,
          wornPercent: c.worn,
        })),
        uncoloured: insights.uncoloured.garments,
        categories: insights.categories.map((row) =>
          breakdownOut(row, 'category'),
        ),
        brands: insights.brands.map((row) => breakdownOut(row, 'brand')),
        unbranded: insights.unbranded,
        condition: insights.condition,
      };
    },
  }),
];
