/**
 * The app's rate limits as the page audit sees them: a step that hits a
 * limited route or tool declares the budget it draws from (`limits` on a
 * step, walk.ts), and the walk waits for room in that budget before each
 * run instead of answering a 429. Steps that share one budget (the link
 * import and its photo choice; add_garment_from_link and suggest_garment)
 * then compose, whatever their run counts and wherever they sit in the
 * walk. Pure: the clock and the sleep are injected (budget.spec.ts).
 */

/** One budget of the app's: the requests one key may make per window. */
export interface AuditLimit {
  /**
   * Names the counter, as the app keys it: the limit, which checker or
   * route counts it, and whose key (`mcp link import (Theo)`). Two steps
   * with one key draw from one budget.
   */
  key: string;
  max: number;
  windowMs: number;
}

/**
 * A limit of the app's (src/web/security/rate-limit.ts) as a budget, so
 * the audit's numbers are the app's own and cannot drift from them.
 */
export function auditLimit(
  key: string,
  appLimit: { max: number; timeWindow: number },
): AuditLimit {
  return { key, max: appLimit.max, windowMs: appLimit.timeWindow };
}

/**
 * Past the window before the next call: the walk records a call when its
 * answer arrives, after the app counted it, so this only covers timer
 * granularity and the app reading its clock a moment later than ours.
 */
export const SAFETY_MARGIN_MS = 1000;

export interface BudgetDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Told each wait before it starts, so a slow walk says why. */
  onWait: (limit: AuditLimit, ms: number) => void;
}

/**
 * The calls each budget has spent, across the whole walk: one tracker per
 * walk, outliving any phase, since a budget can span phases.
 *
 * The window is judged sliding (no more than `max` calls in any `windowMs`)
 * while @fastify/rate-limit's store counts in a fixed window from a key's
 * first call. Any fixed window is one of the sliding ones, so pacing to the
 * sliding rule never trips the fixed one.
 */
export class Budgets {
  private readonly calls = new Map<string, number[]>();
  private readonly declared = new Map<string, AuditLimit>();
  private waited = 0;

  constructor(private readonly deps: BudgetDeps) {}

  /** Milliseconds the walk has spent waiting for budgets. */
  get waitedMs(): number {
    return this.waited;
  }

  /**
   * Runs `call` once every budget in `limits` has room for it, waiting
   * until each one's oldest counted call leaves the window, then counts it
   * in each, whether it succeeded or threw (a refused call may still have
   * been counted). No limits: runs it at once.
   */
  async spend<T>(
    limits: readonly AuditLimit[],
    call: () => Promise<T>,
  ): Promise<T> {
    for (const limit of limits) this.declare(limit);
    for (;;) {
      const [limit, ms] = this.longestWait(limits);
      if (!limit) break;
      this.deps.onWait(limit, ms);
      await this.deps.sleep(ms);
      this.waited += ms;
    }
    try {
      return await call();
    } finally {
      const at = this.deps.now();
      for (const limit of limits) this.calls.get(limit.key)!.push(at);
    }
  }

  /** One key is one budget: a second declaration must agree with the first. */
  private declare(limit: AuditLimit): void {
    const known = this.declared.get(limit.key);
    if (!known) {
      this.declared.set(limit.key, limit);
      this.calls.set(limit.key, []);
      return;
    }
    if (known.max !== limit.max || known.windowMs !== limit.windowMs) {
      throw new Error(
        `The budget "${limit.key}" is declared as ${known.max} per ${known.windowMs} ms and as ${limit.max} per ${limit.windowMs} ms`,
      );
    }
  }

  /** The budget that needs the longest wait for room, or none that does. */
  private longestWait(
    limits: readonly AuditLimit[],
  ): [AuditLimit | undefined, number] {
    let longest: [AuditLimit | undefined, number] = [undefined, 0];
    for (const limit of limits) {
      const ms = this.waitFor(limit);
      if (ms > longest[1]) longest = [limit, ms];
    }
    return longest;
  }

  /** Until the call `max` back leaves the window (and the margin); 0 with room. */
  private waitFor(limit: AuditLimit): number {
    const span = limit.windowMs + SAFETY_MARGIN_MS;
    const now = this.deps.now();
    const calls = this.calls.get(limit.key)!;
    // Older calls never matter again: dropped, so a long walk keeps max each.
    while (calls.length > 0 && calls[0] <= now - span) calls.shift();
    if (calls.length < limit.max) return 0;
    return calls[calls.length - limit.max] + span - now;
  }
}
