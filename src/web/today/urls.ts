import type { Occasion } from '../../wardrobe/occasions';

/**
 * Today's places (#15). `/` is Today: the home screen, the manifest's
 * start_url and where every push reminder opens (src/web/push/reminders.ts).
 */
export const TODAY_PATH = '/';

/** Refresh: a row of today's ideas (always a fragment). */
export const TODAY_IDEAS_PATH = '/today/ideas';

/** "Wear this" on one of today's ideas. */
export const WEAR_THIS_PATH = '/today/wear';

/**
 * The one-shot flag "Wear this" lands on Today with: the entry it wore,
 * whose Undo takes focus and whose result is said (#679).
 */
export const WORE_FLAG = 'wore';

export function todayAfterWear(entryId: number): string {
  return `${TODAY_PATH}?${WORE_FLAG}=${entryId}`;
}

export function todayIdeasUrl(occasion: Occasion, page: number): string {
  return `${TODAY_IDEAS_PATH}?occasion=${occasion}&page=${page}`;
}
