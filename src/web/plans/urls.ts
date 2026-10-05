/**
 * The plans pages' addresses (#34). Plans live under /wardrobe (the
 * Wardrobe's Plans tab, #295), so the dock marks them Wardrobe
 * (layout/sections.ts). They never carry `?ownerId=`: plans
 * are the signed-in owner's own. The style profile sits under the Profile.
 */

export const PLANS_PATH = '/wardrobe/plans';
export const NEW_PLAN_PATH = `${PLANS_PATH}/new`;
export const STYLE_PROFILE_PATH = '/auth/profile/style';
/** Where the home city is set: the profile's Weather section (#14). */
export const WEATHER_SETTINGS_PATH = '/auth/profile#weather';

/** A plan's page, or one of its sub-paths ('/edit', '/duplicate'). */
export function planUrl(id: number, suffix = ''): string {
  return `${PLANS_PATH}/${id}${suffix}`;
}

/** The plan page's views: its items by type, or its outfits (looks). */
export const PLAN_VIEWS = ['items', 'outfits'] as const;
export type PlanView = (typeof PLAN_VIEWS)[number];

/** The plan page in a view; Items, the default, is the bare address. */
export function planViewUrl(id: number, view: PlanView): string {
  return view === 'items' ? planUrl(id) : `${planUrl(id)}?view=${view}`;
}

/**
 * A plan's review (#271): its proposals as strips, decided in one post.
 * Linked from the gap view, the plans list and "Drafted by" while
 * proposals remain.
 */
export function reviewUrl(planId: number): string {
  return planUrl(planId, '/review');
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

/** A look of a plan's sub-path (#291): `/love`, `/change`, `/decline`, `/reconsider`. */
export function lookUrl(
  planId: number,
  lookId: number,
  suffix: string,
): string {
  return planUrl(planId, `/looks/${lookId}${suffix}`);
}

/**
 * The shopping list (34b): the active plan's gaps and their candidates, or
 * another plan's (`?plan=`). The Wardrobe's ⋯ menu, the plans pages and the
 * wishlist link it.
 */
export const SHOPPING_PATH = '/wardrobe/shopping';

/** The shopping list of plan `planId`; the bare path when it is the active one. */
export function shoppingUrl(plan: { id: number; active: boolean }): string {
  return plan.active ? SHOPPING_PATH : `${SHOPPING_PATH}?plan=${plan.id}`;
}

/** Comparing two plans (34b); `a` preselected when given. */
export const COMPARE_PATH = `${PLANS_PATH}/compare`;

export function compareUrl(a?: number): string {
  return a === undefined ? COMPARE_PATH : `${COMPARE_PATH}?a=${a}`;
}

/**
 * An item's candidates page (34b), with where to go back to after saving
 * (the shopping list when it came from there; the plan otherwise).
 */
export function candidatesUrl(
  planId: number,
  itemId: number,
  returnTo?: string,
): string {
  const path = itemUrl(planId, itemId, '/candidates');
  return returnTo === undefined
    ? path
    : `${path}?${new URLSearchParams({ returnTo }).toString()}`;
}

/**
 * A wishlist item's "For plan item…" (34b): which of the owner's plan items
 * it is a candidate for. Under the garment, so the dock marks Wardrobe;
 * never with `?ownerId=`: plans are the owner's own.
 */
export function garmentPlanItemsUrl(garmentId: number): string {
  return `/wardrobe/${garmentId}/plan-items`;
}

/**
 * The id of a candidate's card on the shopping list. Scoped to its item: a
 * product can be a candidate of two items, and ids must be unique.
 */
export function candidateAnchor(itemId: number, garmentId: number): string {
  return `candidate-${itemId}-${garmentId}`;
}
