import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Where a request's server time went, for its `Server-Timing` header
 * (registerHttpMetrics): `db`, the time its queries held a pool connection
 * (the wait for one included; concurrent queries add up), and `render`, the
 * time spent turning JSX into HTML. A device reads both beside its own
 * timings, so a slow tap can be split into server and network.
 *
 * Carried in async context, not passed along: the pool (src/db/client.ts)
 * and the renderer (src/web/render.ts) run far from the request object.
 * Outside a request (the timers, the CLIs) there is no timing and nothing is
 * recorded.
 */
export interface RequestTiming {
  dbMs: number;
  renderMs: number;
  /** A secret the request carries was checked: no Server-Timing (markSecretChecked). */
  secretChecked: boolean;
}

const context = new AsyncLocalStorage<RequestTiming>();

export function newRequestTiming(): RequestTiming {
  return { dbMs: 0, renderMs: 0, secretChecked: false };
}

/** Runs `next` (a Fastify hook's `done`) and everything it leads to with `timing`. */
export function runWithRequestTiming(
  timing: RequestTiming,
  next: () => void,
): void {
  context.run(timing, next);
}

/** The timing of the request this code runs for, if any. */
export function currentRequestTiming(): RequestTiming | undefined {
  return context.getStore();
}

/**
 * Called by every function that checks a secret a request carries, before
 * it looks: verifyPassword (src/web/auth/passwords.ts), authenticateToken
 * (personal-tokens.ts) and the invite lookups (src/web/sharing/queries.ts).
 * That request then answers without Server-Timing, whose `db` and `render`
 * would hand a guesser the server's own time without the network's jitter:
 * whether an email's lookup found a row, whether a token matched (#136).
 * Marked by the check itself rather than declared per route, so a new route
 * that checks a password or a token is covered without remembering to. In
 * async context like the rest of the timing, so the query layer needs no
 * request; outside one (the seed, the CLIs) it does nothing.
 */
export function markSecretChecked(): void {
  const timing = context.getStore();
  if (timing) timing.secretChecked = true;
}

/** Awaits `render`, adding its time to the request's `render`. */
export async function timeRender<T>(render: () => Promise<T>): Promise<T> {
  const timing = context.getStore();
  const started = performance.now();
  try {
    return await render();
  } finally {
    if (timing) timing.renderMs += performance.now() - started;
  }
}

/**
 * The header's value. `route` carries the matched route template as a
 * description, which is how public/js/vitals.js names what it measured
 * without ever sending a URL (a full load reads it from Navigation Timing's
 * serverTiming, an htmx request from the header).
 */
export function serverTimingHeader(
  timing: RequestTiming,
  route: string | undefined,
): string {
  const entries = [
    `db;dur=${timing.dbMs.toFixed(1)}`,
    `render;dur=${timing.renderMs.toFixed(1)}`,
  ];
  if (route) entries.push(`route;desc="${route}"`);
  return entries.join(', ');
}
