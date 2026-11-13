import { CloneType, type Static, Type } from '@sinclair/typebox';
import {
  type Breakdown,
  type CostPerWear,
  type InsightGarment,
  LEAST_WORN_MIN_OWNED_DAYS,
  PAIR_MIN_DAYS,
  RANKED_LIMIT,
  RECENT_DAYS,
  UNWORN_SHOWN,
  type WardrobeInsights,
  type WornPair,
} from '../../wardrobe/insights';
import { GARMENT_COLORS } from '../../wardrobe/properties';
import { RECAP_MIN_WEARS, type YearRecap } from '../../wardrobe/recap';
import { literals, withoutNulls } from '../api/resource';
import { imageUrl, type SignablePhotoRef } from '../files/image-url';
import { IsoDateSchema } from '../schemas';

/**
 * GET /api/v1/insights and /insights/recap (#588): the insights page's and
 * the year in review's figures as data, mapped from the models the pages
 * render (wardrobeInsights, yearRecap), so the app and the page never
 * disagree. Money is a decimal string, as the garment resource's; a
 * percentage a whole number, as the pages show it.
 */

// A function, not CloneType: CloneType keeps a schema's own description.
const Money = (description: string) =>
  Type.String({
    pattern: '^\\d+\\.\\d{2}$',
    description: `${description}: a decimal amount in the household currency`,
  });

const Percent = (description: string) =>
  Type.Number({ minimum: 0, maximum: 100, description });

const InsightGarmentResource = Type.Object(
  {
    id: Type.Integer(),
    name: Type.Optional(Type.String()),
    category: Type.String(),
    brand: Type.Optional(Type.String()),
    quantity: Type.Integer({ minimum: 1 }),
    wearDays: Type.Integer({
      minimum: 0,
      description: 'Distinct days worn, ever (up to the last day counted)',
    }),
    recentWearDays: Type.Integer({
      minimum: 0,
      description: `Distinct days worn in the window: the last ${RECENT_DAYS} days for insights, the year for a recap`,
    }),
    lastWorn: Type.Optional(IsoDateSchema),
    daysSinceWorn: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: 'Days from the last wear to the last day counted',
      }),
    ),
    thumbUrl: Type.Optional(
      Type.String({ description: "The photo's thumb, a signed relative URL" }),
    ),
  },
  {
    title: 'InsightGarment',
    description: 'A garment as a figure counts it',
  },
);

const CostPerWearResource = Type.Object(
  {
    garment: InsightGarmentResource,
    cost: Money('What it cost: the price per piece × copies, plus its repairs'),
    perWear: Type.Optional(
      Money('cost ÷ wear days; absent while not worn yet'),
    ),
  },
  { title: 'CostPerWear' },
);

const PairResource = Type.Object(
  {
    garments: Type.Array(InsightGarmentResource, { minItems: 2, maxItems: 2 }),
    days: Type.Integer({
      minimum: PAIR_MIN_DAYS,
      description: 'Days the two were worn on together',
    }),
  },
  { title: 'WornPair' },
);

const Colour = literals(GARMENT_COLORS);

const BreakdownResource = Type.Object(
  {
    key: Type.Optional(
      Type.String({
        description:
          'The category, or the brand as first spelled; absent for the others summed',
      }),
    ),
    garments: Type.Integer({ minimum: 0 }),
    pieces: Type.Integer({ minimum: 0 }),
    recentWearDays: Type.Integer({ minimum: 0 }),
    closetPercent: Percent("Its share of the closet's garments"),
    wornPercent: Percent(`Its share of the last ${RECENT_DAYS} days' wears`),
  },
  { title: 'InsightBreakdown' },
);

export const InsightsResource = Type.Object(
  {
    today: IsoDateSchema,
    closet: Type.Object({
      garments: Type.Integer({ minimum: 0 }),
      pieces: Type.Integer({ minimum: 0 }),
    }),
    recentWearDays: Type.Integer({
      minimum: 0,
      description: `Wear days in the last ${RECENT_DAYS} days over the closet: 0 when nothing was worn`,
    }),
    worn: Type.Array(
      Type.Object({
        days: Type.Integer(),
        worn: Type.Integer({ minimum: 0 }),
        total: Type.Integer({ minimum: 0 }),
        percent: Percent('worn ÷ total'),
      }),
      {
        description:
          'The share of the closet worn in the last 30, 90 and 365 days, today included',
      },
    ),
    unworn: Type.Object(
      {
        days: Type.Integer(),
        count: Type.Integer({ minimum: 0 }),
        garments: Type.Array(InsightGarmentResource, {
          maxItems: UNWORN_SHOWN,
        }),
      },
      {
        description: `Not worn in \`days\` among the garments owned that long (or undated), never worn first; the first ${UNWORN_SHOWN} of \`count\``,
      },
    ),
    mostWorn: Type.Array(InsightGarmentResource, { maxItems: RANKED_LIMIT }),
    leastWorn: Type.Array(InsightGarmentResource, {
      maxItems: RANKED_LIMIT,
      description: `Among garments owned ${LEAST_WORN_MIN_OWNED_DAYS} days or more, leaving out the most worn`,
    }),
    cost: Type.Object({
      best: Type.Array(CostPerWearResource, {
        description: 'The lowest cost per wear first',
      }),
      worst: Type.Array(CostPerWearResource, {
        description: 'The highest first; none of them in `best`',
      }),
      notWornYet: Type.Array(CostPerWearResource, {
        description: 'Priced and never worn, the most expensive first',
      }),
      notWornYetCount: Type.Integer({ minimum: 0 }),
      closetValue: Money('What the priced garments cost, repairs included'),
      priced: Type.Integer({ minimum: 0 }),
      unpriced: Type.Integer({ minimum: 0 }),
    }),
    pairs: Type.Array(PairResource, {
      description: `Worn together most often in the last ${RECENT_DAYS} days`,
    }),
    colours: Type.Array(
      Type.Object({
        colour: Colour,
        closetPercent: Percent(
          "Its share of the closet's garments (a two-colour garment is half of each)",
        ),
        wornPercent: Percent(
          `Its share of the last ${RECENT_DAYS} days' wears`,
        ),
      }),
    ),
    uncoloured: Type.Object(
      {
        garments: Type.Integer({ minimum: 0 }),
        closetPercent: Percent("Their share of the closet's garments"),
        wornPercent: Percent(
          `Their share of the last ${RECENT_DAYS} days' wears`,
        ),
      },
      { description: 'Garments without a colour: the rest of each strip' },
    ),
    categories: Type.Array(BreakdownResource),
    brands: Type.Array(BreakdownResource, {
      description:
        'Grouped regardless of case and spaces; the others summed last, without a key',
    }),
    unbranded: Type.Integer({ minimum: 0 }),
    condition: Type.Object({
      needsRepair: Type.Integer({ minimum: 0 }),
      replaceSoon: Type.Integer({ minimum: 0 }),
    }),
  },
  {
    title: 'Insights',
    description:
      'How your closet is used, from your wear log: the closet is garments not archived and not on the wishlist, each counted once whatever its copies; wears are distinct days',
  },
);
type InsightsResource = Static<typeof InsightsResource>;

export const RecapResource = Type.Object(
  {
    year: Type.Integer(),
    from: IsoDateSchema,
    to: CloneType(IsoDateSchema, {
      description: 'December 31, or today while the year runs',
    }),
    complete: Type.Boolean({ description: 'False while the year runs' }),
    wears: Type.Integer({
      minimum: 0,
      description: 'Garment-days worn in the year',
    }),
    piecesWorn: Type.Integer({ minimum: 0 }),
    enough: Type.Boolean({
      description: `At least ${RECAP_MIN_WEARS} wears: else the page shows its empty state`,
    }),
    earlier: Type.Boolean({
      description: 'Something was worn before the year: an earlier recap',
    }),
    mostWorn: Type.Array(InsightGarmentResource, {
      description: "By the year's wear days",
    }),
    additions: Type.Object(
      {
        count: Type.Integer({ minimum: 0 }),
        garments: Type.Array(InsightGarmentResource),
      },
      { description: 'Acquired in the year, the newest first' },
    ),
    bestValue: Type.Array(CostPerWearResource, {
      description:
        'The best cost per wear among the pieces worn in the year, over their wears up to `to`',
    }),
    colours: Type.Array(
      Type.Object({
        colour: Colour,
        wornPercent: Percent("Its share of the year's wears"),
      }),
      { description: 'The largest first' },
    ),
    uncolouredWorn: Percent(
      "The share of the year's wears by garments without a colour",
    ),
    pair: Type.Optional(PairResource),
  },
  {
    title: 'YearRecap',
    description:
      "The year in review, from your wear log: insights' rules over a calendar year, garments archived since included",
  },
);
type RecapResource = Static<typeof RecapResource>;

type Garment = InsightGarment<SignablePhotoRef>;

function toInsightGarment(garment: Garment) {
  return withoutNulls({
    id: garment.id,
    name: garment.name,
    category: garment.category,
    brand: garment.brand,
    quantity: garment.quantity,
    wearDays: garment.wearDays,
    recentWearDays: garment.recentWearDays,
    lastWorn: garment.lastWorn,
    daysSinceWorn: garment.daysSinceWorn,
    thumbUrl: garment.photo && imageUrl(garment.photo, 'thumb'),
  });
}

function toCostPerWear(entry: CostPerWear<SignablePhotoRef>) {
  return withoutNulls({
    garment: toInsightGarment(entry.garment),
    cost: entry.cost,
    perWear: entry.perWear,
  });
}

function toPair({ a, b, days }: WornPair<SignablePhotoRef>) {
  return { garments: [toInsightGarment(a), toInsightGarment(b)], days };
}

function toBreakdown(row: Breakdown) {
  return withoutNulls({
    key: row.key,
    garments: row.garments,
    pieces: row.pieces,
    recentWearDays: row.recentWearDays,
    closetPercent: row.closet,
    wornPercent: row.worn,
  });
}

export function toInsightsResource(
  insights: WardrobeInsights<SignablePhotoRef>,
  today: string,
): InsightsResource {
  const { cost, unworn, uncoloured } = insights;
  return {
    today,
    closet: insights.closet,
    recentWearDays: insights.recentWearDays,
    worn: insights.worn,
    unworn: {
      days: unworn.days,
      count: unworn.garments.length,
      garments: unworn.garments.slice(0, UNWORN_SHOWN).map(toInsightGarment),
    },
    mostWorn: insights.mostWorn.map(toInsightGarment),
    leastWorn: insights.leastWorn.map(toInsightGarment),
    cost: {
      best: cost.best.map(toCostPerWear),
      worst: cost.worst.map(toCostPerWear),
      notWornYet: cost.notWornYet.map(toCostPerWear),
      notWornYetCount: cost.notWornYetCount,
      closetValue: cost.closetValue,
      priced: cost.priced,
      unpriced: cost.unpriced,
    },
    pairs: insights.pairs.map(toPair),
    colours: insights.colours.map((c) => ({
      colour: c.colour,
      closetPercent: c.closet,
      wornPercent: c.worn,
    })),
    uncoloured: {
      garments: uncoloured.garments,
      closetPercent: uncoloured.closet,
      wornPercent: uncoloured.worn,
    },
    categories: insights.categories.map(toBreakdown),
    brands: insights.brands.map(toBreakdown),
    unbranded: insights.unbranded,
    condition: insights.condition,
  };
}

export function toRecapResource(
  recap: YearRecap<SignablePhotoRef>,
): RecapResource {
  const { period } = recap;
  return withoutNulls({
    year: period.year,
    from: period.from,
    to: period.to,
    complete: period.complete,
    wears: recap.wears,
    piecesWorn: recap.piecesWorn,
    enough: recap.enough,
    earlier: recap.earlier,
    mostWorn: recap.mostWorn.map(toInsightGarment),
    additions: {
      count: recap.additions.count,
      garments: recap.additions.garments.map(toInsightGarment),
    },
    bestValue: recap.bestValue.map(toCostPerWear),
    colours: recap.colours.map((c) => ({
      colour: c.colour,
      wornPercent: c.worn,
    })),
    uncolouredWorn: recap.uncolouredWorn,
    pair: recap.pair && toPair(recap.pair),
  });
}
