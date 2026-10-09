import { brandKey, brandSpelling } from './brands';
import type { Condition, GarmentColor } from './properties';
import { fromCents, toCents } from './money';

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
 * - What a garment cost is totalCost's, on every surface: its price ×
 *   copies plus its repairs (#151).
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

/**
 * One garment in the closet with its wear counts (insightGarments).
 * `Photo` is the caller's photo reference, passed through untouched: this
 * layer never reads it (src/web/insights/queries.ts supplies a
 * SignablePhotoRef), like the outfit generator's garment type.
 */
export interface InsightGarment<Photo = unknown> {
  id: number;
  name: string | null;
  category: string;
  brand: string | null;
  /** A set, null for none (garment.colors). */
  colors: readonly GarmentColor[] | null;
  quantity: number;
  /** Per piece, the price paid ("Bought it" records it over the listed one). */
  price: string | null;
  /**
   * What its repairs dated up to the window's last day cost in all
   * (repairCostSql); null when none gives a cost. The owner's own record.
   */
  repairCost: string | null;
  condition: Condition;
  photo: Photo | null;
  /** 'YYYY-MM-DD', null without a date (a recap's new additions). */
  acquiredOn: string | null;
  /** Distinct days worn, ever (up to the window's last day). */
  wearDays: number;
  /**
   * Distinct days worn in the window: the last RECENT_DAYS for insights, the
   * year for a recap (src/wardrobe/recap.ts).
   */
  recentWearDays: number;
  lastWorn: string | null;
  /** Days from the last wear to today (the window's last day); null when never worn. */
  daysSinceWorn: number | null;
  /** Days from acquired_on to today (the window's last day); null without a date. */
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

export interface CostPerWear<Photo = unknown> {
  garment: InsightGarment<Photo>;
  /** What the garment cost (totalCost): price × quantity plus repairs. */
  cost: string;
  /** cost ÷ wear days; null when not worn yet (never divided). */
  perWear: string | null;
}

export interface ColourShare {
  colour: GarmentColor;
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

export interface WardrobeInsights<Photo = unknown> {
  closet: { garments: number; pieces: number };
  /** Recent wear days over the closet (0: nothing worn in the last year). */
  recentWearDays: number;
  worn: WornShare[];
  unworn: { days: UnwornDays; garments: InsightGarment<Photo>[] };
  mostWorn: InsightGarment<Photo>[];
  leastWorn: InsightGarment<Photo>[];
  cost: {
    /** Lowest cost per wear first. */
    best: CostPerWear<Photo>[];
    /** Highest cost per wear first (worn ones; none in `best`). */
    worst: CostPerWear<Photo>[];
    /** Priced and never worn, the most expensive first. */
    notWornYet: CostPerWear<Photo>[];
    notWornYetCount: number;
    /** What the priced garments cost (totalCost), repairs included. */
    closetValue: string;
    priced: number;
    unpriced: number;
  };
  pairs: { a: InsightGarment<Photo>; b: InsightGarment<Photo>; days: number }[];
  colours: ColourShare[];
  /**
   * Garments without a colour, and their percent of the closet and of the
   * recent wear days: the rest of each strip, so the colours' shares are
   * of the whole closet (#123).
   */
  uncoloured: { garments: number; closet: number; worn: number };
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
function unwornList<Photo>(
  garments: InsightGarment<Photo>[],
  days: number,
): InsightGarment<Photo>[] {
  return garments
    .filter((g) => unwornIn(g, days) && ownedFor(g, days))
    .sort(
      (a, b) =>
        (b.daysSinceWorn ?? Infinity) - (a.daysSinceWorn ?? Infinity) ||
        byId(a, b),
    );
}

/** What a garment's cost is made of (#151). */
export interface GarmentCosts {
  /** Per piece, the price paid. */
  price: string | null;
  quantity: number;
  /** Its repairs' costs summed (repairCostSql); null when none gives one. */
  repairCost: string | null;
}

/**
 * What a garment cost: its price per piece × quantity, plus what its
 * repairs cost (once: a repair is money spent, whatever the copies), in
 * cents. Null without a price: repairs alone are not what a garment cost,
 * so an unpriced garment stays out of cost per wear, repaired or not. The
 * one definition insights, the recap, wardrobe_stats, get_garment and the
 * garment page's wear line share; repairs are the owner's own, so it is
 * only ever computed from an owner-only read (insightGarments,
 * wearSummarySql).
 */
export function totalCost(costs: GarmentCosts): string | null {
  if (costs.price === null) return null;
  const repairs = costs.repairCost === null ? 0 : toCents(costs.repairCost);
  return fromCents(toCents(costs.price) * costs.quantity + repairs);
}

/**
 * What one wear of a garment cost: its total cost (totalCost) over its
 * wear days, rounded to the cent; null when it has not been worn yet (never
 * divided). The one rule, shared by insights and the garment page's wear
 * line (#84).
 */
export function perWearCost(total: string, wearDays: number): string | null {
  if (wearDays === 0) return null;
  return fromCents(Math.round(toCents(total) / wearDays));
}

/** A garment's cost per wear; none without a price (totalCost). */
function costPerWear<Photo>(
  garment: InsightGarment<Photo>,
): CostPerWear<Photo>[] {
  const cost = totalCost(garment);
  if (cost === null) return [];
  return [{ garment, cost, perWear: perWearCost(cost, garment.wearDays) }];
}

/**
 * Cost per wear over `garments`: the best and worst values, the priced ones
 * not worn yet, the closet's value. Insights' card, and a recap's best value
 * (src/wardrobe/recap.ts) over the pieces worn that year.
 */
export function costFigures<Photo>(
  garments: InsightGarment<Photo>[],
): WardrobeInsights<Photo>['cost'] {
  const priced = garments.flatMap(costPerWear);
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
 * Each colour's share of the whole closet and of all the recent wear days.
 * A garment in k colours counts 1/k to each; one without a colour counts
 * to `uncoloured`, so the colours and it add up to the closet (a closet
 * half untagged is not all its colours at 100%). A recap's colours worn
 * are the `worn` shares over the pieces worn that year.
 */
export function colourShares(
  garments: InsightGarment[],
): Pick<WardrobeInsights, 'colours' | 'uncoloured'> {
  const shares = new Map<GarmentColor, { closet: number; worn: number }>();
  const uncoloured = { garments: 0, wornDays: 0 };
  let wornDays = 0;
  for (const garment of garments) {
    wornDays += garment.recentWearDays;
    const colours = garment.colors ?? [];
    if (colours.length === 0) {
      uncoloured.garments += 1;
      uncoloured.wornDays += garment.recentWearDays;
      continue;
    }
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
        closet: percent(share.closet, garments.length),
        worn: percent(share.worn, wornDays),
      })),
    uncoloured: {
      garments: uncoloured.garments,
      closet: percent(uncoloured.garments, garments.length),
      worn: percent(uncoloured.wornDays, wornDays),
    },
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
 * Brands grouped by brandKey, regardless of case and spaces ("UNIQLO" is
 * Uniqlo), under the spelling of the first garment added; the first
 * BRANDS_LIMIT by name, the rest summed as one row with a null key.
 */
function brands(garments: InsightGarment[]): {
  brands: Breakdown[];
  unbranded: number;
} {
  const oldestFirst = [...garments].sort(byId);
  const all = breakdown(oldestFirst, (g) => {
    const label = brandSpelling(g.brand ?? '');
    return label ? { group: brandKey(label), label } : null;
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
export function wardrobeInsights<Photo>(
  garments: InsightGarment<Photo>[],
  pairRows: PairRow[],
  unwornDays: UnwornDays,
): WardrobeInsights<Photo> {
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
    cost: costFigures(garments),
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
