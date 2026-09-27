import { QUANTITY_MAX } from './availability';
import {
  type Condition,
  type Formality,
  GARMENT_COLORS,
  GARMENT_TYPES,
  type GarmentColor,
  GarmentCategory,
  isBuiltInCategory,
  type Warmth,
} from './properties';

/**
 * Wardrobe plans (#34, slice 34a; plan section 15): what the wardrobe should
 * be, as abstract targets in the garment model's own terms, and how the
 * closet measures up. Pure: no database, web or strings (the gap view and
 * the MCP tools turn the answers into words). Two parts:
 *
 * - matchPlan: each plan item against the closet (only garments inCloset:
 *   the wishlist and the archive are not owned clothes), owned, partly or
 *   missing, and why.
 * - planItemsFromWardrobe: a wardrobe's garments as plan items ("start from
 *   the demo": Theo's closet as the owner's target).
 *
 * Nothing here is stored: which garments fulfil an item is derived on every
 * read, like wear counts, so buying, archiving or retagging a garment moves
 * the gap view with no write to keep in step. (34b's "Bought it fulfils a
 * plan item" is this: the bought garment enters the closet and matches.)
 */

/** How much an item matters: the gap view's order, and a tie-break in matching. */
export const PLAN_PRIORITIES = ['high', 'medium', 'low'] as const;
export type PlanPriority = (typeof PLAN_PRIORITIES)[number];

/** Both ends inclusive, as OCCASION_HINTS' formality (src/wardrobe/occasions.ts). */
export interface Range<T extends number> {
  min: T;
  max: T;
}

/**
 * A plan item as matching reads it. Every constraint is optional but the
 * category: an empty colour or material list, a null type or range, means
 * any.
 */
export interface PlanTarget {
  id: number;
  category: string;
  type: string | null;
  /** The garment must have every one of these (and may have others). */
  colors: readonly string[];
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
  colors: readonly string[];
  materials: readonly string[];
  warmth: Warmth | null;
  formality: Formality | null;
  /** Identical copies (src/wardrobe/availability.ts): a ×3 tee is 3 toward an item. */
  quantity: number;
  condition: Condition;
}

export type ItemStatus = 'owned' | 'partly' | 'missing';

/**
 * Why an item is not owned (null when it is), the first that applies:
 * - replace-soon: garments that match are marked replace_soon (#7's
 *   condition): worn out, so they are the gap to refill, not a fulfilment.
 * - too-few-copies: partly owned: what matches fulfils it, short of the
 *   quantity.
 * - taken-by-other-items: missing, though garments match: each fulfils
 *   another item (takenBy names them).
 * - nothing-matches: nothing in the closet fits the item at all.
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
  /** Matching garments counted for another item instead. */
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
 * Whether `garment` is the kind of thing `item` asks for, condition aside:
 * the same category, the item's type if it names one, every colour and
 * material it names (a Breton stripe is a blue top), and warmth and
 * formality inside its ranges (a garment without the value is outside one).
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
 * Every item of a plan against the closet, in the items' order.
 *
 * One garment fulfils at most one item, with all its copies (a garment row
 * is one thing on a shelf; three identical tees are one garment of 3, and
 * cannot be half in one item and half in another). The assignment is
 * greedy, not an optimal matching, and deterministic:
 * 1. Items choose in order of fewest candidates (matching garments in good
 *    or needs_repair condition), then priority, then id: a specific item
 *    ("white heavyweight tee") chooses before a general one ("any tee")
 *    could take its only garment.
 * 2. An item takes its closest unclaimed candidates (fewest colours and
 *    materials beyond its own, good before needs_repair, oldest first)
 *    until their copies reach its quantity.
 *
 * Condition (#7): replace_soon never fulfils (the garment is the gap, "the
 * replace_soon merino feeds the gap view"); needs_repair does, flagged,
 * because it is still in the closet and worn (the app's rule: condition
 * is not availability). Away (lent, at the repair shop) and dirty copies
 * are owned all the same: a plan is about what the wardrobe holds.
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

/** How many items of a plan are owned, partly owned and missing. */
export function planTally(
  matches: readonly ItemMatch[],
): Record<ItemStatus, number> {
  const tally = { owned: 0, partly: 0, missing: 0 };
  for (const match of matches) tally[match.status] += 1;
  return tally;
}

/** A garment of a wardrobe a plan is started from (in its closet). */
export interface SourceGarment {
  id: number;
  name: string | null;
  brand: string | null;
  category: string;
  type: string | null;
  colors: readonly GarmentColor[];
  quantity: number;
  /** '49.90'; null when unknown. */
  price: string | null;
}

/** A plan item derived from a group of a wardrobe's garments. */
export interface DerivedItem {
  category: string;
  type: string | null;
  /** The group's colour set, in GARMENT_COLORS order. */
  colors: GarmentColor[];
  /** The group's copies, capped at the form's QUANTITY_MAX. */
  quantity: number;
  /** The dearest piece's price: what the source wardrobe paid for one. */
  budget: string | null;
  /** The garments it came from, for the item's note (the web layer words it). */
  sources: { name: string | null; brand: string | null }[];
}

const COLOR_ORDER = new Map<string, number>(
  GARMENT_COLORS.map((color, index) => [color, index]),
);
const CATEGORY_ORDER: readonly string[] = Object.values(GarmentCategory);

/** Built-in categories in enum order, then custom ones by name. */
function categoryRank(a: string, b: string): number {
  const ai = CATEGORY_ORDER.indexOf(a);
  const bi = CATEGORY_ORDER.indexOf(b);
  if (ai === -1 && bi === -1) return a.localeCompare(b);
  if (ai === -1) return 1;
  if (bi === -1) return -1;
  return ai - bi;
}

/** Colour sets position by position in the palette's order; a prefix first. */
function compareColorSets(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const order = COLOR_ORDER.get(a[i])! - COLOR_ORDER.get(b[i])!;
    if (order !== 0) return order;
  }
  return a.length - b.length;
}

/** A type's place in its category's list (the form's order); untyped last. */
function typeRank(category: string, type: string | null): number {
  if (type === null || !isBuiltInCategory(category)) return Number.MAX_VALUE;
  const index = GARMENT_TYPES[category].findIndex((t) => t.value === type);
  return index === -1 ? Number.MAX_VALUE : index;
}

/**
 * "Start from the demo": a wardrobe's closet as plan items, one per kind of
 * garment it holds: grouped by category, type and colour set (three white
 * tees and a white heavyweight tee are "white t-shirt ×4"), in the order
 * the wardrobe lists them. Warmth, formality and materials are left open:
 * the plan says what to own, and the owner narrows an item where it
 * matters. The owner's Theo is the target (owner, 2026-09-26).
 */
export function planItemsFromWardrobe(
  garments: readonly SourceGarment[],
): DerivedItem[] {
  const groups = new Map<string, DerivedItem>();
  for (const garment of garments) {
    const colors = [...new Set(garment.colors)].sort(
      (a, b) => COLOR_ORDER.get(a)! - COLOR_ORDER.get(b)!,
    );
    const key = [garment.category, garment.type ?? '', colors.join(',')].join(
      '\u0000',
    );
    let group = groups.get(key);
    if (!group) {
      group = {
        category: garment.category,
        type: garment.type,
        colors,
        quantity: 0,
        budget: null,
        sources: [],
      };
      groups.set(key, group);
    }
    group.quantity = Math.min(QUANTITY_MAX, group.quantity + garment.quantity);
    if (
      garment.price !== null &&
      (group.budget === null || Number(garment.price) > Number(group.budget))
    ) {
      group.budget = garment.price;
    }
    group.sources.push({ name: garment.name, brand: garment.brand });
  }
  return [...groups.values()].sort(
    (a, b) =>
      categoryRank(a.category, b.category) ||
      typeRank(a.category, a.type) - typeRank(b.category, b.type) ||
      (a.type ?? '').localeCompare(b.type ?? '') ||
      compareColorSets(a.colors, b.colors),
  );
}
