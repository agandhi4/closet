import type { Condition, Formality, GarmentColor, Warmth } from './properties';

/**
 * What the closet covers (get_closet_coverage, #337): targets an agent
 * states in the garment model's own terms, judged against the garments in
 * the closet (only inCloset: the wishlist and the archive are not owned
 * clothes), owned, partly or missing, and why. Pure: no database, web or
 * strings. The wardrobe plans' gap analysis (#34), kept when plans went,
 * which is why its names still say plan.
 *
 * Nothing here is stored: which garments fulfil a target is derived on
 * every call, like wear counts, so buying, archiving or retagging a garment
 * moves the answer with no write to keep in step.
 */

/** How much a target matters: a tie-break in matching. */
export const PLAN_PRIORITIES = ['high', 'medium', 'low'] as const;
export type PlanPriority = (typeof PLAN_PRIORITIES)[number];

/** Both ends inclusive, as OCCASION_HINTS' formality (src/wardrobe/occasions.ts). */
export interface Range<T extends number> {
  min: T;
  max: T;
}

/**
 * A target as matching reads it. Every constraint is optional but the
 * category: an empty colour or material list, a null type or range, means
 * any.
 */
export interface PlanTarget {
  id: number;
  category: string;
  type: string | null;
  /** The garment must have every one of these (and may have others). */
  colors: readonly GarmentColor[];
  /** The same rule as colours. */
  materials: readonly string[];
  warmth: Range<Warmth> | null;
  formality: Range<Formality> | null;
  /** Copies wanted (1 to QUANTITY_MAX). */
  quantity: number;
  priority: PlanPriority;
}

/** A garment in the closet (inCloset) as matching reads it. */
export interface ClosetPiece {
  id: number;
  category: string;
  type: string | null;
  colors: readonly GarmentColor[];
  materials: readonly string[];
  warmth: Warmth | null;
  formality: Formality | null;
  /** Identical copies (src/wardrobe/availability.ts): a ×3 tee is 3 toward a target. */
  quantity: number;
  condition: Condition;
}

export type ItemStatus = 'owned' | 'partly' | 'missing';

/**
 * Why a target is not owned (null when it is), the first that applies:
 * - replace-soon: garments that match are marked replace_soon (#7's
 *   condition): worn out, so they are the gap to refill, not a fulfilment.
 * - too-few-copies: partly owned: what matches fulfils it, short of the
 *   quantity.
 * - taken-by-other-items: missing, though garments match: each fulfils
 *   another target (takenBy names them).
 * - nothing-matches: nothing in the closet fits the target at all.
 */
export type GapReason =
  | 'replace-soon'
  | 'taken-by-other-items'
  | 'too-few-copies'
  | 'nothing-matches';

export interface ItemMatch {
  itemId: number;
  status: ItemStatus;
  /** Copies of the fulfilling garments (may pass `need`: a ×6 garment for ×4). */
  have: number;
  need: number;
  /** The garments counted for it, closest first. needs_repair counts, flagged. */
  fulfilledBy: { garmentId: number; copies: number; needsRepair: boolean }[];
  /** Matching garments marked replace_soon: not counted, the gap to refill. */
  replaceSoon: number[];
  /** Matching garments counted for another target instead. */
  takenBy: { garmentId: number; itemId: number }[];
  reason: GapReason | null;
}

function within<T extends number>(
  value: T | null,
  range: Range<T> | null,
): boolean {
  return (
    range === null ||
    (value !== null && value >= range.min && value <= range.max)
  );
}

function hasAll(have: readonly string[], wanted: readonly string[]): boolean {
  return wanted.every((value) => have.includes(value));
}

/**
 * Whether `garment` is the kind of thing `item` asks for: the same
 * category, the item's type if it names one, every colour and material it
 * names (a Breton stripe is a blue top), and warmth and formality inside
 * its ranges (a garment without the value is outside one). Condition aside.
 */
export function matchesTarget(item: PlanTarget, garment: ClosetPiece): boolean {
  return (
    garment.category === item.category &&
    (item.type === null || garment.type === item.type) &&
    hasAll(garment.colors, item.colors) &&
    hasAll(garment.materials, item.materials) &&
    within(garment.warmth, item.warmth) &&
    within(garment.formality, item.formality)
  );
}

/** How far a match is from exact: colours and materials beyond the item's. */
function distance(item: PlanTarget, garment: ClosetPiece): number {
  const extra = (have: readonly string[], wanted: readonly string[]) =>
    wanted.length === 0 ? 0 : have.filter((v) => !wanted.includes(v)).length;
  return (
    extra(garment.colors, item.colors) +
    extra(garment.materials, item.materials)
  );
}

const PRIORITY_RANK: Record<PlanPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/**
 * Every target against the closet, in the targets' order.
 *
 * One garment fulfils at most one target, with all its copies (a garment
 * row is one thing on a shelf; three identical tees are one garment of 3,
 * and cannot be half in one target and half in another). The assignment is
 * greedy, not an optimal matching, and deterministic:
 * 1. Targets choose in order of fewest candidates (matching garments in
 *    good or needs_repair condition), then priority, then id: a specific
 *    target ("white heavyweight tee") chooses before a general one ("any
 *    tee") could take its only garment.
 * 2. A target takes its closest unclaimed candidates (fewest colours and
 *    materials beyond its own, good before needs_repair, oldest first)
 *    until their copies reach its quantity.
 *
 * Condition (#7): replace_soon never fulfils (the garment is the gap to
 * refill); needs_repair does, flagged, because it is still in the closet
 * and worn (the app's rule: condition is not availability). Away (lent, at
 * the repair shop) and dirty copies are owned all the same: coverage is
 * about what the wardrobe holds.
 */
export function matchPlan(
  items: readonly PlanTarget[],
  garments: readonly ClosetPiece[],
): ItemMatch[] {
  const matching = new Map(
    items.map((item) => [
      item.id,
      garments.filter((garment) => matchesTarget(item, garment)),
    ]),
  );
  const usable = (garment: ClosetPiece) => garment.condition !== 'replace_soon';
  const candidates = (item: PlanTarget) =>
    matching.get(item.id)!.filter(usable).length;
  const order = [...items].sort(
    (a, b) =>
      candidates(a) - candidates(b) ||
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      a.id - b.id,
  );

  /** Garment id to the item it fulfils. */
  const claimed = new Map<number, number>();
  const chosen = new Map<number, ClosetPiece[]>();
  for (const item of order) {
    const pool = matching
      .get(item.id)!
      .filter((garment) => usable(garment) && !claimed.has(garment.id))
      .sort(
        (a, b) =>
          distance(item, a) - distance(item, b) ||
          Number(a.condition === 'needs_repair') -
            Number(b.condition === 'needs_repair') ||
          a.id - b.id,
      );
    const taken: ClosetPiece[] = [];
    let copies = 0;
    for (const garment of pool) {
      if (copies >= item.quantity) break;
      taken.push(garment);
      claimed.set(garment.id, item.id);
      copies += garment.quantity;
    }
    chosen.set(item.id, taken);
  }

  return items.map((item) => {
    const taken = chosen.get(item.id)!;
    const all = matching.get(item.id)!;
    const have = taken.reduce((sum, garment) => sum + garment.quantity, 0);
    const replaceSoon = all.filter((g) => !usable(g)).map((g) => g.id);
    const takenBy = all
      // A match nobody claimed (the item had enough without it) is not taken.
      .filter(
        (g) => usable(g) && claimed.has(g.id) && claimed.get(g.id) !== item.id,
      )
      .map((g) => ({ garmentId: g.id, itemId: claimed.get(g.id)! }));
    const status: ItemStatus =
      have >= item.quantity ? 'owned' : have > 0 ? 'partly' : 'missing';
    return {
      itemId: item.id,
      status,
      have,
      need: item.quantity,
      fulfilledBy: taken.map((garment) => ({
        garmentId: garment.id,
        copies: garment.quantity,
        needsRepair: garment.condition === 'needs_repair',
      })),
      replaceSoon,
      takenBy,
      reason: status === 'owned' ? null : gapReason(have, replaceSoon, takenBy),
    };
  });
}

function gapReason(
  have: number,
  replaceSoon: readonly number[],
  takenBy: readonly unknown[],
): GapReason {
  if (replaceSoon.length > 0) return 'replace-soon';
  if (have > 0) return 'too-few-copies';
  return takenBy.length > 0 ? 'taken-by-other-items' : 'nothing-matches';
}
