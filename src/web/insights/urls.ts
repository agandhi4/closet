import { DEFAULT_UNWORN_DAYS, type UnwornDays } from '../../wardrobe/insights';
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

/** The grid's "Needs attention" filter (condition not good). */
export const NEEDS_ATTENTION_URL = wardrobeUrl(undefined, {
  attention: 'true',
});
