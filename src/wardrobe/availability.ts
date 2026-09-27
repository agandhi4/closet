import { categoryRole, GarmentCategory, type GarmentRole } from './properties';
import type { GarmentStatus } from './status';

/**
 * Whether a garment can be worn now: the wash rules (wears since the last
 * wash against a limit, counted per copy for multiples) and the manual
 * `away` state (lent, at the repair shop). Pure: the counts come from
 * `garment_wear` rows (src/web/wears/queries.ts computes the same rules in
 * SQL for pages that filter or page by them; test/integration/wears.spec.ts
 * proves the two agree). Condition (src/wardrobe/properties.ts) is not part
 * of this on purpose: a worn-out tee is still wearable.
 *
 * Design: docs/plans/2026-09-26-wardrobe-features.md, section 1.
 */

/** Why a garment is out of the closet for now (garment.away). */
export const AWAY_REASONS = ['lent', 'repair'] as const;
export type AwayReason = (typeof AWAY_REASONS)[number];

/**
 * Wears before a wash when the garment says nothing (wash_after_wears
 * null); null is never (shoes, belts and bags are not laundered). The
 * limit is per copy: three white tees at 1 are three wears.
 */
const ROLE_WASH_AFTER: Record<GarmentRole, number | null> = {
  top: 1,
  'one-piece': 1,
  bottom: 3,
  layer: 10,
  footwear: null,
  accessory: null,
  bag: null,
  none: null,
};

/**
 * garment.wash_after_wears' "never" (the raw denim nobody washes). Null
 * there means the role's default, so "never" needs a value of its own;
 * washLimit() is the only reader that turns it back into null.
 */
export const NEVER_WASH = 0;

/** What the garment form offers for "wash after" (NEVER_WASH aside). */
export const WASH_AFTER_CHOICES = [1, 2, 3, 4, 5, 7, 10, 15, 20] as const;

/** The most identical copies one garment row stands for (the form's cap). */
export const QUANTITY_MAX = 30;

/** The role's default wears before a wash; null for never. */
export function defaultWashAfter(category: string): number | null {
  return ROLE_WASH_AFTER[categoryRole(category)];
}

/**
 * Wears a copy takes before it needs a wash: the garment's own setting,
 * else its role's default; null when it never does.
 */
export function washLimit(
  category: string,
  washAfterWears: number | null,
): number | null {
  if (washAfterWears === NEVER_WASH) return null;
  return washAfterWears ?? defaultWashAfter(category);
}

/**
 * Wears since the last wash: distinct days after `lastWashedOn` (every
 * day when it was never washed). Two entries on one day are one wear, and
 * a wear on the wash day counts as before it: you wash what you wore.
 * Days are 'YYYY-MM-DD', which compare as dates.
 */
export function wearsSinceWash(
  days: readonly string[],
  lastWashedOn: string | null,
): number {
  return new Set(
    days.filter((day) => lastWashedOn === null || day > lastWashedOn),
  ).size;
}

export interface WashState {
  /** Identical copies (garment.quantity, at least 1). */
  quantity: number;
  /** washLimit(); null: never needs a wash. */
  limit: number | null;
  wearsSinceWash: number;
}

/**
 * Copies worn their limit since the wash: a copy is dirty once it has been
 * worn `limit` times, and the next wear takes a clean one. Capped at the
 * quantity (the extra wears were on dirty copies again).
 *
 * The plan wrote ceil(wears / limit); that marks a pair of jeans (limit 3)
 * dirty after one wear, against the same plan's threshold rule (dirty when
 * the wears reach the limit). Floor is the threshold rule per copy, and the
 * two agree wherever the limit is 1 (the tees).
 */
export function dirtyCopies(state: WashState): number {
  if (state.limit === null) return 0;
  return Math.min(
    state.quantity,
    Math.floor(state.wearsSinceWash / state.limit),
  );
}

export function cleanCopies(state: WashState): number {
  return state.quantity - dirtyCopies(state);
}

/**
 * At least one copy needs a wash: the laundry page's list, the grid's
 * "Needs a wash" filter and mark ("2 of 3 need a wash" for multiples).
 */
export function needsWash(state: WashState): boolean {
  return dirtyCopies(state) > 0;
}

/**
 * The generator-facing rule (the outfit gallery #9, the packing list #10):
 * a garment can be put in an outfit now when it is in the closet (its
 * status, src/wardrobe/status.ts: not a wishlist item, not archived), not
 * away, and a clean copy is left. src/web/wears/queries.ts's
 * `availableGarment` is the same rule as a query condition; use one of the
 * two, never a third.
 */
export function isAvailable(
  garment: WashState & { status: GarmentStatus; away: AwayReason | null },
): boolean {
  return (
    garment.status === 'closet' &&
    garment.away === null &&
    cleanCopies(garment) > 0
  );
}

/**
 * The built-in categories with a default limit, as (category, limit) pairs:
 * defaultWashAfter as data, for its SQL form (src/web/wears/queries.ts).
 * Every other category, custom ones included, is never.
 */
export function defaultWashAfterByCategory(): [GarmentCategory, number][] {
  return Object.values(GarmentCategory).flatMap((category) => {
    const limit = defaultWashAfter(category);
    return limit === null ? [] : [[category, limit]];
  });
}
