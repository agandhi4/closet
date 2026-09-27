import { DEFAULT_UNWORN_DAYS, type UnwornDays } from '../../wardrobe/insights';
import { ideasUrl } from '../gallery/urls';
import { wardrobeUrl } from '../wardrobe/urls';

/**
 * Insights' addresses (#17). Under /wardrobe (the Wardrobe's ⋯ menu beside
 * Plans and Shopping, docs/plans/2026-09-26-redesign.md), so the dock marks
 * them Wardrobe (layout/sections.ts). Never `?ownerId=`: insights are the
 * signed-in owner's own, like wears.
 */

export const INSIGHTS_PATH = '/wardrobe/insights';

/** The page with the unworn list over `days`; the bare path for the default. */
export function insightsUrl(days: UnwornDays): string {
  return days === DEFAULT_UNWORN_DAYS
    ? INSIGHTS_PATH
    : `${INSIGHTS_PATH}?unworn=${days}`;
}

/**
 * "Style this" on an unworn garment: the outfit gallery's ideas that all
 * hold it (`/outfits/ideas?with=<id>`, #9), for no day in particular, as
 * the garment page's own "Style this".
 */
export function styleThisUrl(garmentId: number): string {
  return ideasUrl({ destination: { kind: 'none' }, withId: garmentId });
}

/** The grid's "Needs attention" filter (condition not good). */
export const NEEDS_ATTENTION_URL = wardrobeUrl(undefined, {
  attention: 'true',
});
