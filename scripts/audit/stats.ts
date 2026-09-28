/**
 * The page audit's arithmetic (scripts/audit-pages.ts): pure, so
 * stats.spec.ts pins it.
 */

/** Summary of one step's timed runs, in milliseconds. */
export interface Timing {
  n: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
}

/** A count that should not vary between runs; min and max say when it did. */
export interface Count {
  median: number;
  min: number;
  max: number;
}

/**
 * The `p`th percentile (0..100) of `values`, linearly interpolated between
 * the closest ranks (R-7, what numpy and spreadsheets default to), so a p95
 * of 20 runs is not simply the slowest one.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new Error('percentile of no values');
  if (p < 0 || p > 100) throw new Error(`percentile ${p} is outside 0..100`);
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

export function summarizeTiming(values: readonly number[]): Timing {
  return {
    n: values.length,
    min: Math.min(...values),
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: Math.max(...values),
  };
}

export function summarizeCount(values: readonly number[]): Count {
  return {
    median: percentile(values, 50),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

/** Signed change from `before` to `after` as a fraction (0.1 is +10%); 0 when both are 0. */
export function relativeChange(before: number, after: number): number {
  if (before === 0) return after === 0 ? 0 : Infinity;
  return (after - before) / before;
}

/**
 * How far two runs of the same build disagree: over every step both have,
 * the absolute relative change of p50, as its median and 90th percentile.
 * The README's noise figures are this, between two runs on the same box.
 */
export function noiseBetween(
  pairs: readonly { before: number; after: number }[],
): { median: number; p90: number; steps: number } {
  const changes = pairs
    .filter((pair) => pair.before > 0)
    .map((pair) => Math.abs(relativeChange(pair.before, pair.after)));
  if (changes.length === 0) return { median: 0, p90: 0, steps: 0 };
  return {
    median: percentile(changes, 50),
    p90: percentile(changes, 90),
    steps: changes.length,
  };
}
