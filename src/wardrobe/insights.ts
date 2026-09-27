import type { Condition } from './properties';
import { fromCents, toCents } from './shopping';

/**
 * Insights (#17, docs/plans/2026-09-26-wardrobe-features.md section 10): how
 * the closet is actually used, computed on every request from the wear log
 * and nothing stored. Pure: the rows come from src/web/insights/queries.ts
 * (one per garment in the closet, one per pair worn together), with every
 * day count already taken in the household's calendar there, so nothing
 * here does date arithmetic. The page (src/web/insights/) and the MCP tool
 * wardrobe_stats (src/web/mcp/tools/insights.ts) both read this.
 *
 * The definitions (CLAUDE.md, Insights, repeats them):
 * - The closet is the owner's garments in it (inCloset: not archived, not
 *   the wishlist). Every figure is per garment: a set of identical copies
 *   (quantity 3) is one garment, worn when any copy was. Quantity counts
 *   only where money or pieces are the question: cost per wear, the
 *   closet's value and the category breakdown's pieces.
 * - Wears are distinct days (the wear log's rule): two outfits on one day
 *   holding the same shoes are one wear.
 * - "Worn in the last N days": a wear on today or one of the N - 1 days
 *   before it.
 */

/** The windows of "worn lately", in days. */
export const WORN_WINDOWS = [30, 90, 365] as const;

/** The choices of "not worn in N days"; the page's default is the middle one. */
export const UNWORN_CHOICES = [30, 90, 180] as const;
export type UnwornDays = (typeof UNWORN_CHOICES)[number];
export const DEFAULT_UNWORN_DAYS: UnwornDays = 90;

export function isUnwornDays(value: number): value is UnwornDays {
  return (UNWORN_CHOICES as readonly number[]).includes(value);
}

/**
 * Days a garment must have been owned before it can be called least worn:
 * a season, so a coat bought in May is not judged in July. A garment
 * without an acquired date is taken as owned long enough (it was in the
 * closet before anyone recorded when).
 */
export const LEAST_WORN_MIN_OWNED_DAYS = 90;

/**
 * The window of the usage shares (colours, categories, brands) and of the
 * pairs: the last year, so a long history keeps both current and the
 * pairs' self-join bounded.
 */
export const RECENT_DAYS = 365;

/** How many garments each ranked list shows. */
export const RANKED_LIMIT = 5;

/** How many unworn garments the page and the tool list (the count is whole). */
export const UNWORN_SHOWN = 48;

/** The pairs shown, and the days together a pair needs to count (once is chance). */
export const PAIRS_LIMIT = 5;
export const PAIR_MIN_DAYS = 2;

/** The brands listed by name; the rest are summed as others. */
export const BRANDS_LIMIT = 8;

/** One garment in the closet with its wear counts (insightGarments). */
export interface InsightGarment {
  id: number;
  name: string | null;
  category: string;
  brand: string | null;
  /** The stored comma-joined colour list, null for none. */
  color: string | null;
  quantity: number;
  /** Per piece, the price paid ("Bought it" records it over the listed one). */
  price: string | null;
  condition: Condition;
  photo: { fileName: string; version: number } | null;
  /** Distinct days worn, ever. */
  wearDays: number;
  /** Distinct days worn in the last RECENT_DAYS. */
  recentWearDays: number;
  lastWorn: string | null;
  /** Days from the last wear to today; null when never worn. */
  daysSinceWorn: number | null;
  /** Days from acquired_on to today; null without a date. */
  daysOwned: number | null;
}

/** Two garments worn on the same days (wornPairs), `a` < `b`. */
export interface PairRow {
  a: number;
  b: number;
  days: number;
}

export interface WornShare {
  days: number;
  /** Garments worn in the window. */
  worn: number;
  /** Garments in the closet. */
  total: number;
  /** worn / total as a whole percentage, 0 for an empty closet. */
  percent: number;
}

export interface CostPerWear {
  garment: InsightGarment;
  /** price × quantity, what the garment cost. */
  cost: string;
  /** cost ÷ wear days; null when not worn yet (never divided). */
  perWear: string | null;
}

export interface ColourShare {
  colour: string;
  /** Percent of the closet's garments (a two-colour garment is half of each). */
  closet: number;
  /** Percent of the recent wear days, split the same way. */
  worn: number;
}

export interface Breakdown {
  /** The category, or the brand as first spelled; null for "the others". */
  key: string | null;
  garments: number;
  pieces: number;
  recentWearDays: number;
  /** Percent of the closet's garments. */
  closet: number;
  /** Percent of the recent wear days. */
  worn: number;
}

export interface WardrobeInsights {
  closet: { garments: number; pieces: number };
  /** Recent wear days over the closet (0: nothing worn in the last year). */
  recentWearDays: number;
  worn: WornShare[];
  unworn: { days: UnwornDays; garments: InsightGarment[] };
  mostWorn: InsightGarment[];
  leastWorn: InsightGarment[];
  cost: {
    /** Lowest cost per wear first. */
    best: CostPerWear[];
    /** Highest cost per wear first (worn ones; none in `best`). */
    worst: CostPerWear[];
    /** Priced and never worn, the most expensive first. */
    notWornYet: CostPerWear[];
    notWornYetCount: number;
    /** Sum of price × quantity over the priced garments. */
    closetValue: string;
    priced: number;
    unpriced: number;
  };
  pairs: { a: InsightGarment; b: InsightGarment; days: number }[];
  colours: ColourShare[];
  /** Garments without a colour (left out of the strip). */
  uncoloured: number;
  categories: Breakdown[];
  brands: Breakdown[];
  /** Garments without a brand (left out of the brands). */
  unbranded: number;
  condition: { needsRepair: number; replaceSoon: number };
}

function percent(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 100);
}

function byId(a: InsightGarment, b: InsightGarment): number {
  return a.id - b.id;
}

/** "Not worn in N days": never worn, or last worn N days ago or more. */
function unwornIn(garment: InsightGarment, days: number): boolean {
  return garment.daysSinceWorn === null || garment.daysSinceWorn >= days;
}

/** Owned at least `days` (or since before anyone recorded when). */
function ownedFor(garment: InsightGarment, days: number): boolean {
  return garment.daysOwned === null || garment.daysOwned >= days;
}

/**
 * Not worn in `days`, among garments owned at least that long (a shirt
 * bought last week has had no chance): never worn first, then the longest
 * since, then the oldest id.
 */
function unwornList(
  garments: InsightGarment[],
  days: number,
): InsightGarment[] {
  return garments
    .filter((g) => unwornIn(g, days) && ownedFor(g, days))
    .sort(
      (a, b) =>
        (b.daysSinceWorn ?? Infinity) - (a.daysSinceWorn ?? Infinity) ||
        byId(a, b),
    );
}

function costPerWear(garment: InsightGarment): CostPerWear {
  const cents = toCents(garment.price!) * garment.quantity;
  return {
    garment,
    cost: fromCents(cents),
    perWear:
      garment.wearDays === 0
        ? null
        : fromCents(Math.round(cents / garment.wearDays)),
  };
}

function costs(garments: InsightGarment[]): WardrobeInsights['cost'] {
  const priced = garments.filter((g) => g.price !== null).map(costPerWear);
  const worn = priced
    .filter((c) => c.perWear !== null)
    .sort(
      (a, b) =>
        toCents(a.perWear!) - toCents(b.perWear!) || byId(a.garment, b.garment),
    );
  // The cheaper half at most is "best", the dearer half "worst", so a small
  // closet shows both and no garment is in both.
  const half = Math.ceil(worn.length / 2);
  const notWornYet = priced
    .filter((c) => c.perWear === null)
    .sort(
      (a, b) => toCents(b.cost) - toCents(a.cost) || byId(a.garment, b.garment),
    );
  return {
    best: worn.slice(0, Math.min(RANKED_LIMIT, half)),
    worst: worn.slice(Math.max(half, worn.length - RANKED_LIMIT)).reverse(),
    notWornYet: notWornYet.slice(0, RANKED_LIMIT),
    notWornYetCount: notWornYet.length,
    closetValue: fromCents(priced.reduce((sum, c) => sum + toCents(c.cost), 0)),
    priced: priced.length,
    unpriced: garments.length - priced.length,
  };
}

/**
 * Each colour's share of the closet and of what was worn. A garment in k
 * colours counts 1/k to each, so the strip adds up to the closet.
 */
function colourShares(garments: InsightGarment[]): {
  colours: ColourShare[];
  uncoloured: number;
} {
  const shares = new Map<string, { closet: number; worn: number }>();
  let coloured = 0;
  let wornDays = 0;
  for (const garment of garments) {
    const colours = garment.color ? garment.color.split(',') : [];
    if (colours.length === 0) continue;
    coloured += 1;
    wornDays += garment.recentWearDays;
    for (const colour of colours) {
      const share = shares.get(colour) ?? { closet: 0, worn: 0 };
      share.closet += 1 / colours.length;
      share.worn += garment.recentWearDays / colours.length;
      shares.set(colour, share);
    }
  }
  return {
    colours: [...shares]
      .sort(
        ([colourA, a], [colourB, b]) =>
          b.closet - a.closet || colourA.localeCompare(colourB),
      )
      .map(([colour, share]) => ({
        colour,
        closet: percent(share.closet, coloured),
        worn: percent(share.worn, wornDays),
      })),
    uncoloured: garments.length - coloured,
  };
}

/** Garments grouped by `keyOf`, the largest group first. */
function breakdown(
  garments: InsightGarment[],
  keyOf: (garment: InsightGarment) => { group: string; label: string } | null,
): Breakdown[] {
  const groups = new Map<string, Omit<Breakdown, 'closet' | 'worn'>>();
  for (const garment of garments) {
    const key = keyOf(garment);
    if (!key) continue;
    const group = groups.get(key.group) ?? {
      key: key.label,
      garments: 0,
      pieces: 0,
      recentWearDays: 0,
    };
    group.garments += 1;
    group.pieces += garment.quantity;
    group.recentWearDays += garment.recentWearDays;
    groups.set(key.group, group);
  }
  const total = garments.length;
  const wornDays = garments.reduce((sum, g) => sum + g.recentWearDays, 0);
  return [...groups.values()]
    .sort(
      (a, b) =>
        b.garments - a.garments ||
        b.recentWearDays - a.recentWearDays ||
        (a.key ?? '').localeCompare(b.key ?? ''),
    )
    .map((group) => ({
      ...group,
      closet: percent(group.garments, total),
      worn: percent(group.recentWearDays, wornDays),
    }));
}

/**
 * Brands grouped regardless of case and surrounding spaces ("UNIQLO" is
 * Uniqlo), under the spelling of the first garment added; the first
 * BRANDS_LIMIT by name, the rest summed as one row with a null key.
 */
function brands(garments: InsightGarment[]): {
  brands: Breakdown[];
  unbranded: number;
} {
  const oldestFirst = [...garments].sort(byId);
  const all = breakdown(oldestFirst, (g) => {
    const label = g.brand?.trim();
    return label ? { group: label.toLowerCase(), label } : null;
  });
  const named = all.slice(0, BRANDS_LIMIT);
  const rest = all.slice(BRANDS_LIMIT);
  if (rest.length > 0) {
    const wornDays = garments.reduce((sum, g) => sum + g.recentWearDays, 0);
    const others = rest.reduce(
      (sum, b) => ({
        garments: sum.garments + b.garments,
        pieces: sum.pieces + b.pieces,
        recentWearDays: sum.recentWearDays + b.recentWearDays,
      }),
      { garments: 0, pieces: 0, recentWearDays: 0 },
    );
    named.push({
      key: null,
      ...others,
      closet: percent(others.garments, garments.length),
      worn: percent(others.recentWearDays, wornDays),
    });
  }
  const branded = all.reduce((sum, b) => sum + b.garments, 0);
  return { brands: named, unbranded: garments.length - branded };
}

/**
 * Everything the insights page and wardrobe_stats show, from the closet's
 * garments and its most-worn pairs. `unwornDays` picks the unworn list's
 * window.
 */
export function wardrobeInsights(
  garments: InsightGarment[],
  pairRows: PairRow[],
  unwornDays: UnwornDays,
): WardrobeInsights {
  const total = garments.length;
  const byIdMap = new Map(garments.map((g) => [g.id, g]));

  const mostWorn = garments
    .filter((g) => g.wearDays > 0)
    .sort(
      (a, b) =>
        b.wearDays - a.wearDays ||
        (a.daysSinceWorn ?? 0) - (b.daysSinceWorn ?? 0) ||
        byId(a, b),
    )
    .slice(0, RANKED_LIMIT);
  const mostIds = new Set(mostWorn.map((g) => g.id));
  const leastWorn = garments
    .filter((g) => ownedFor(g, LEAST_WORN_MIN_OWNED_DAYS) && !mostIds.has(g.id))
    .sort(
      (a, b) =>
        a.wearDays - b.wearDays ||
        (b.daysSinceWorn ?? Infinity) - (a.daysSinceWorn ?? Infinity) ||
        byId(a, b),
    )
    .slice(0, RANKED_LIMIT);

  const pairs = pairRows.flatMap(({ a, b, days }) => {
    const first = byIdMap.get(a);
    const second = byIdMap.get(b);
    return first && second ? [{ a: first, b: second, days }] : [];
  });

  return {
    closet: {
      garments: total,
      pieces: garments.reduce((sum, g) => sum + g.quantity, 0),
    },
    recentWearDays: garments.reduce((sum, g) => sum + g.recentWearDays, 0),
    worn: WORN_WINDOWS.map((days) => {
      const worn = garments.filter((g) => !unwornIn(g, days)).length;
      return { days, worn, total, percent: percent(worn, total) };
    }),
    unworn: { days: unwornDays, garments: unwornList(garments, unwornDays) },
    mostWorn,
    leastWorn,
    cost: costs(garments),
    pairs,
    ...colourShares(garments),
    categories: breakdown(garments, (g) => ({
      group: g.category,
      label: g.category,
    })),
    ...brands(garments),
    condition: {
      needsRepair: garments.filter((g) => g.condition === 'needs_repair')
        .length,
      replaceSoon: garments.filter((g) => g.condition === 'replace_soon')
        .length,
    },
  };
}
