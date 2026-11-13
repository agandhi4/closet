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
