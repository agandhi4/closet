import {
  type ColourShare,
  colourShares,
  costFigures,
  type CostPerWear,
  type InsightGarment,
  type PairRow,
  RANKED_LIMIT,
} from './insights';

/**
 * A year in review (#26, docs/plans/2026-09-28-yearly-recap.md): insights'
 * rows read over one calendar year (src/web/insights/queries.ts,
 * InsightsWindow: `recentWearDays` is the year's wear days, `wearDays` and
 * every "days since" stop at the period's last day, archived garments
 * included), summed up with insights' own rules. Pure, like insights: no
 * date arithmetic, only comparisons of 'YYYY-MM-DD' strings.
 */

/**
 * The wears (garment-days, insights' unit) a year needs to be recapped:
 * fewer and every list is a tie of ones. Below it the page is its empty
 * state and offers no image.
 */
export const RECAP_MIN_WEARS = 10;

/** The recap's days: January 1 to December 31, or to today in the current year. */
export interface RecapPeriod {
  year: number;
  /** January 1. */
  from: string;
  /** December 31, or today (the household's) while the year runs. */
  to: string;
  /** False while the year runs: "2026 so far". */
  complete: boolean;
}

export interface YearRecap<Photo = unknown> {
  period: RecapPeriod;
  /** Garment-days worn in the year (insights' wears). */
  wears: number;
  /** Garments worn at least once in the year. */
  piecesWorn: number;
  /** Enough wears to recap (RECAP_MIN_WEARS). */
  enough: boolean;
  /** Something was worn before the year: an earlier recap to link to. */
  earlier: boolean;
  /** By the year's wear days, ties the most recently worn first. */
  mostWorn: InsightGarment<Photo>[];
  /** Acquired in the year, the newest first; `count` is all of them. */
  additions: { garments: InsightGarment<Photo>[]; count: number };
  /**
   * Insights' best cost per wear among the pieces worn in the year, over
   * their wears up to the period's last day.
   */
  bestValue: CostPerWear<Photo>[];
  /** Each colour's share of the year's wears, the largest first; none unworn. */
  colours: ColourShare[];
  /** The share of the year's wears by garments without a colour. */
  uncolouredWorn: number;
  /** The two pieces worn together on the most days of the year. */
  pair: {
    a: InsightGarment<Photo>;
    b: InsightGarment<Photo>;
    days: number;
  } | null;
}

function byId(a: InsightGarment, b: InsightGarment): number {
  return a.id - b.id;
}

/** A garment acquired in the period (none without a date: nothing says when). */
function acquiredIn(garment: InsightGarment, period: RecapPeriod): boolean {
  const day = garment.acquiredOn;
  return day !== null && day >= period.from && day <= period.to;
}

/**
 * The recap of `period` from its rows (insightGarments and wornPairs over
 * the year, scope owned).
 */
export function yearRecap<Photo>(
  garments: InsightGarment<Photo>[],
  pairRows: PairRow[],
  period: RecapPeriod,
): YearRecap<Photo> {
  const worn = garments.filter((g) => g.recentWearDays > 0);
  const wears = worn.reduce((sum, g) => sum + g.recentWearDays, 0);

  const mostWorn = [...worn]
    .sort(
      (a, b) =>
        b.recentWearDays - a.recentWearDays ||
        (a.daysSinceWorn ?? 0) - (b.daysSinceWorn ?? 0) ||
        byId(a, b),
    )
    .slice(0, RANKED_LIMIT);

  const added = garments
    .filter((g) => acquiredIn(g, period))
    .sort((a, b) => b.acquiredOn!.localeCompare(a.acquiredOn!) || byId(b, a));

  const { colours, uncoloured } = colourShares(worn);

  const byIdMap = new Map(garments.map((g) => [g.id, g]));
  const [pair] = pairRows.flatMap(({ a, b, days }) => {
    const first = byIdMap.get(a);
    const second = byIdMap.get(b);
    return first && second ? [{ a: first, b: second, days }] : [];
  });

  return {
    period,
    wears,
    piecesWorn: worn.length,
    enough: wears >= RECAP_MIN_WEARS,
    earlier: garments.some((g) => g.wearDays > g.recentWearDays),
    mostWorn,
    additions: { garments: added.slice(0, RANKED_LIMIT), count: added.length },
    bestValue: costFigures(worn).best,
    colours: colours
      .filter((colour) => colour.worn > 0)
      .sort((a, b) => b.worn - a.worn || a.colour.localeCompare(b.colour)),
    uncolouredWorn: uncoloured.worn,
    pair: pair ?? null,
  };
}
