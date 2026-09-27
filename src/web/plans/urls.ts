/**
 * The plans pages' addresses (#34). Plans live under /wardrobe (the
 * Wardrobe's ⋯ menu, docs/plans/2026-09-26-redesign.md), so the dock marks
 * them Wardrobe (layout/sections.ts). They never carry `?ownerId=`: plans
 * are the signed-in owner's own. The style profile sits under the Profile.
 */

export const PLANS_PATH = '/wardrobe/plans';
export const STYLE_PROFILE_PATH = '/auth/profile/style';
/** Where the home city is set: the profile's Weather section (#14). */
export const WEATHER_SETTINGS_PATH = '/auth/profile#weather';

/** A plan's page, or one of its sub-paths ('/edit', '/duplicate'). */
export function planUrl(id: number, suffix = ''): string {
  return `${PLANS_PATH}/${id}${suffix}`;
}

/** A plan's items: where the add form posts. */
export function itemsUrl(planId: number): string {
  return planUrl(planId, '/items');
}

/** An item of a plan ('new' for the add form), or one of its sub-paths. */
export function itemUrl(
  planId: number,
  itemId: number | 'new',
  suffix = '',
): string {
  return `${itemsUrl(planId)}/${itemId}${suffix}`;
}
