import { addDays, type IsoDate } from './calendar-date';

/**
 * The writes the installed app queues while offline and replays on
 * reconnect (#178, docs/plans/2026-11-12-offline-queued-writes.md), each
 * kind with the route its replay posts to. Each of those routes names its
 * kind (`config: { queueable }`, src/web/offline-writes.ts), and
 * test/integration/queued-writes.spec.ts holds the routes and this list
 * equal both ways: the page's outbox replays only a path that matches one
 * of these, so a route missing here would never be replayed and one only
 * here would be replayed without the account check.
 */
export const QUEUEABLE_ROUTES = {
  wear: '/wardrobe/:id/wear',
  wash: '/wardrobe/:id/washed',
  entry: '/calendar/:id/worn',
  packed: '/trips/:id/packed',
  item: '/trips/:id/items/packed',
} as const;

export type QueueableKind = keyof typeof QUEUEABLE_ROUTES;

/**
 * How far back a replayed wear or wash may be dated (owner decision 3,
 * 2026-11-13): a phone offline longer than a week asks for the wear to be
 * added from the calendar instead.
 */
export const REPLAY_WINDOW_DAYS = 7;

/** Why a queued write is refused, sent as `X-Closet-Outcome` with its 409. */
export type ReplayRefusal = 'too-old' | 'future' | 'account';

/**
 * An explicit day on Wore today or Washed (the tap's day, not the replay's)
 * is accepted from `today - REPLAY_WINDOW_DAYS` to `today`; anything else
 * is the refusal to answer. Undefined when the day is accepted.
 */
export function dayRefusal(
  day: IsoDate,
  today: IsoDate,
): Exclude<ReplayRefusal, 'account'> | undefined {
  if (day > today) return 'future';
  if (day < addDays(today, -REPLAY_WINDOW_DAYS)) return 'too-old';
  return undefined;
}

/**
 * The page's outbox (views/assets/outbox.ts, bundled into public/js/outbox.js;
 * plan section 3) and the views that mark the queueable controls share
 * these rules, so a key the server renders is the key the outbox collapses
 * by.
 */

/** Where a queued write replays, and the key its records collapse by. */
export interface QueuedTarget {
  /**
   * One record per key, the last intent wins: `wear:41:2026-11-12` (a
   * garment's wear on a day), `wash:41`, `entry:88`, `packed:7:41` (a
   * trip's garment), `item:7:3` (a trip's extra).
   */
  key: string;
  path: string;
}

/**
 * The target of a queued write: `id` is the route's `:id` (the garment, the
 * entry, the trip); `part` what the key adds, a wear's day or the trip's
 * garment or extra.
 */
export function queuedTarget(
  kind: QueueableKind,
  id: number,
  part?: number | IsoDate,
): QueuedTarget {
  return {
    key: [kind, id, ...(part === undefined ? [] : [part])].join(':'),
    path: QUEUEABLE_ROUTES[kind].replace(':id', String(id)),
  };
}

const QUEUEABLE_PATHS = Object.entries(QUEUEABLE_ROUTES).map(
  ([kind, pattern]) => ({
    kind: kind as QueueableKind,
    path: new RegExp(`^${pattern.replace(':id', '[1-9]\\d{0,9}')}$`),
  }),
);

/**
 * The kind a stored record's path replays as, or undefined: the outbox
 * replays nothing else (plan section 7), whatever its store holds.
 */
export function queueableKindOf(path: string): QueueableKind | undefined {
  return QUEUEABLE_PATHS.find((route) => route.path.test(path))?.kind;
}

/** The kinds whose record posts the tap's `day` (todayIn APP_TIMEZONE). */
export function takesDay(kind: QueueableKind): boolean {
  return kind === 'wear' || kind === 'wash';
}

/** The packing ticks: a record per item, posting `shown` and `packed`. */
export function isChecklist(kind: QueueableKind): boolean {
  return kind === 'packed' || kind === 'item';
}

/**
 * The most records waiting at once: past it the queueable controls are
 * disabled offline, with the banner saying why.
 */
export const OUTBOX_MAX_PENDING = 200;

/** Why a queued write was not saved: the notice's reason. */
export type ReplayFailure = 'gone' | 'refused' | ReplayRefusal;

/** What the outbox does with a record after its replay's answer. */
export type ReplayVerdict =
  /** Saved (204): the record goes. */
  | { verdict: 'saved'; changed: boolean }
  /** Refused for good: the record stays, failed, until dismissed. */
  | { verdict: 'failed'; reason: ReplayFailure }
  /** The server may take it later (5xx, 408, 429): stop, back off. */
  | { verdict: 'retry' }
  /** No session (401): stop, keep everything for the next sign-in. */
  | { verdict: 'signed-out' };

function isRefusal(outcome: string | null): outcome is ReplayRefusal {
  return outcome === 'too-old' || outcome === 'future' || outcome === 'account';
}

/**
 * A replay's answer (src/web/offline-writes.ts): 204 saved, 401 signed out,
 * 404 gone (a deleted garment, entry or trip), a 409 refused for the reason
 * in `X-Closet-Outcome` (a wishlist item has none), a server error or rate
 * limit retried. Anything else (a 400, a 403, a redirect) is refused: the
 * page must never take an answer it does not know for saved.
 */
export function replayVerdict(
  status: number,
  outcome: string | null,
): ReplayVerdict {
  if (status === 204)
    return { verdict: 'saved', changed: outcome === 'changed' };
  if (status === 401) return { verdict: 'signed-out' };
  if (status === 404) return { verdict: 'failed', reason: 'gone' };
  if (status === 409 && isRefusal(outcome)) {
    return { verdict: 'failed', reason: outcome };
  }
  if (status >= 500 || status === 408 || status === 429) {
    return { verdict: 'retry' };
  }
  return { verdict: 'failed', reason: 'refused' };
}

const RETRY_FIRST_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

/** The wait before the next drain after `attempts` failed ones: 5 s doubling, at most 5 min. */
export function retryDelayMs(attempts: number): number {
  return Math.min(
    RETRY_FIRST_MS * 2 ** Math.max(attempts - 1, 0),
    RETRY_MAX_MS,
  );
}
