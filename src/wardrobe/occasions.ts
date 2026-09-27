import type { Formality } from './properties';

/**
 * The part of the day a calendar entry is for (#13; plan section 8):
 * `outfit_calendar.occasion`. A fixed set, so each carries defaults the
 * rest of the app reads from here and nowhere else:
 * - the weather's time window (#14): which hours of the day's forecast the
 *   outfit has to dress for (work 8 am to 6 pm, evening 6 to 11 pm);
 * - a formality hint (#9's generator, Today #15): the range of garment
 *   formality (src/wardrobe/properties.ts FORMALITIES: 1 lounge, 2 casual,
 *   3 smart casual, 4 dressy) that suits it.
 * Pure: no database, web or strings (the labels are the catalog's
 * `occasion.<value>`). The check constraint on the column lists OCCASIONS,
 * so adding one is a migration (CLAUDE.md, Gotchas).
 */

/**
 * In display order: all day first (it frames the day), then the others in
 * the order their windows start. A day's entries show in this order.
 */
export const OCCASIONS = [
  'all-day',
  'workout',
  'work',
  'daytime',
  'evening',
  'night-out',
] as const;
export type Occasion = (typeof OCCASIONS)[number];

/** What an entry is for when nobody said: every entry made before #13, and a post without one. */
export const DEFAULT_OCCASION: Occasion = 'all-day';

export interface OccasionHints {
  /**
   * Hours of the day in APP_TIMEZONE, `from` inclusive and `to` exclusive
   * (0 to 24). A default: the weather reads the forecast over it.
   */
  window: { from: number; to: number };
  /** The garment formality that suits it, both ends inclusive. */
  formality: { min: Formality; max: Formality };
}

export const OCCASION_HINTS: Readonly<Record<Occasion, OccasionHints>> = {
  // An everyday outfit for the whole waking day.
  'all-day': { window: { from: 8, to: 22 }, formality: { min: 2, max: 3 } },
  // A morning run or gym session, before the day's outfit.
  workout: { window: { from: 6, to: 9 }, formality: { min: 1, max: 1 } },
  // The plan's rule: at least smart casual.
  work: { window: { from: 8, to: 18 }, formality: { min: 3, max: 4 } },
  // Errands, brunch, a museum: out and about in daylight.
  daytime: { window: { from: 10, to: 18 }, formality: { min: 2, max: 3 } },
  // Dinner, a date.
  evening: { window: { from: 18, to: 23 }, formality: { min: 3, max: 4 } },
  // Drinks and late plans: a bar in jeans or a club in a jacket.
  'night-out': { window: { from: 21, to: 24 }, formality: { min: 2, max: 4 } },
};

export function isOccasion(value: string): value is Occasion {
  return (OCCASIONS as readonly string[]).includes(value);
}

/** Sorts a day's entries into display order (Array.prototype.sort is stable, so ties keep theirs). */
export function compareOccasions(a: Occasion, b: Occasion): number {
  return OCCASIONS.indexOf(a) - OCCASIONS.indexOf(b);
}
