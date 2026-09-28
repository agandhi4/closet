import { type ItemMatch, PLAN_PRIORITIES, type PlanPriority } from './plans';

/**
 * The shopping list (#34, slice 34b): a plan's gaps as what to buy. Pure,
 * like matching: the web layer and the MCP tools hand it the gap view's
 * items (matchPlan's answers) and each item's candidate products (wishlist
 * garments, src/web/plans/candidates.ts), and word what it returns.
 *
 * Money is in cents here (prices and budgets arrive as the numeric
 * column's strings, '49.90'), so totals never pick up a float's error.
 */

/** A plan item as the list reads it. */
export interface ShoppingItem {
  id: number;
  priority: PlanPriority;
  /** Per piece, '49.90'; null when the owner set none. */
  budget: string | null;
}

/** A candidate product as the list reads it. */
export interface ShoppingCandidate {
  garmentId: number;
  /** The listed price, '49.90'; null when unknown. */
  price: string | null;
  /** Whether it is the kind of thing the item asks for (targetDifferences, none). */
  matches: boolean;
}

/** Whether a candidate's price is within the item's budget per piece. */
export type BudgetFit = 'within' | 'over' | 'unknown';

export interface ShoppingEntry<
  I extends ShoppingItem,
  C extends ShoppingCandidate,
> {
  item: I;
  match: ItemMatch;
  /** Copies still to buy: what the item needs beyond what the closet has. */
  toBuy: number;
  /**
   * Its candidates, the likeliest first: those that match the item before
   * those that do not, within the budget before over it before an unknown
   * price, then cheapest, then oldest.
   */
  candidates: { candidate: C; budget: BudgetFit }[];
}

export interface ShoppingTotals {
  /** Items on the list. */
  items: number;
  /** Copies to buy, over every item. */
  pieces: number;
  /** Budget × copies to buy, over the items with a budget, in cents. */
  budgetCents: number;
  /** Items on the list without a budget (left out of budgetCents). */
  unbudgeted: number;
  /**
   * The cheapest matching, priced candidate × copies to buy, over the items
   * that have one, in cents: what the list costs as it stands.
   */
  cheapestCents: number;
  /** Items on the list without a matching, priced candidate (left out of cheapestCents). */
  withoutPricedMatch: number;
}

/** '49.90' as 4990. The column's strings have at most two decimals. */
export function toCents(price: string): number {
  return Math.round(Number(price) * 100);
}

/** 4990 as '49.90', the form priceLabel reads. */
export function fromCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

function budgetFit(price: string | null, budget: string | null): BudgetFit {
  if (price === null || budget === null) return 'unknown';
  return toCents(price) <= toCents(budget) ? 'within' : 'over';
}

const FIT_RANK: Record<BudgetFit, number> = { within: 0, over: 1, unknown: 2 };

/**
 * Cheapest first, unpriced last. Without a budget every candidate's fit is
 * 'unknown', so this alone orders them; a null that compared equal to
 * everything made the sort intransitive (an unpriced one before priced ones).
 */
function comparePrices(a: string | null, b: string | null): number {
  if (a === null || b === null) return Number(a === null) - Number(b === null);
  return toCents(a) - toCents(b);
}
const PRIORITY_RANK = new Map<string, number>(
  PLAN_PRIORITIES.map((priority, index) => [priority, index]),
);
const STATUS_RANK = { missing: 0, partly: 1, owned: 2 } as const;

/**
 * A plan's shopping list: its missing and partly owned items (owned ones
 * are not shopping), the highest priority first, then missing before
 * partly, then oldest; each with the copies to buy and its candidates in
 * the order they are likeliest to be bought.
 */
export function shoppingList<
  I extends ShoppingItem,
  C extends ShoppingCandidate,
>(
  gaps: readonly { item: I; match: ItemMatch }[],
  candidatesOf: (itemId: number) => readonly C[],
): ShoppingEntry<I, C>[] {
  return gaps
    .filter(({ match }) => match.status !== 'owned')
    .sort(
      (x, y) =>
        PRIORITY_RANK.get(x.item.priority)! -
          PRIORITY_RANK.get(y.item.priority)! ||
        STATUS_RANK[x.match.status] - STATUS_RANK[y.match.status] ||
        x.item.id - y.item.id,
    )
    .map(({ item, match }) => ({
      item,
      match,
      toBuy: match.need - match.have,
      candidates: candidatesOf(item.id)
        .map((candidate) => ({
          candidate,
          budget: budgetFit(candidate.price, item.budget),
        }))
        .sort(
          (x, y) =>
            Number(y.candidate.matches) - Number(x.candidate.matches) ||
            FIT_RANK[x.budget] - FIT_RANK[y.budget] ||
            comparePrices(x.candidate.price, y.candidate.price) ||
            x.candidate.garmentId - y.candidate.garmentId,
        ),
    }));
}

/** What the list adds up to (the page's summary and get_shopping_list's). */
export function shoppingTotals(
  entries: readonly ShoppingEntry<ShoppingItem, ShoppingCandidate>[],
): ShoppingTotals {
  const totals: ShoppingTotals = {
    items: entries.length,
    pieces: 0,
    budgetCents: 0,
    unbudgeted: 0,
    cheapestCents: 0,
    withoutPricedMatch: 0,
  };
  for (const entry of entries) {
    totals.pieces += entry.toBuy;
    if (entry.item.budget === null) totals.unbudgeted += 1;
    else totals.budgetCents += toCents(entry.item.budget) * entry.toBuy;
    const prices = entry.candidates
      .filter(({ candidate }) => candidate.matches && candidate.price !== null)
      .map(({ candidate }) => toCents(candidate.price!));
    if (prices.length === 0) totals.withoutPricedMatch += 1;
    else totals.cheapestCents += Math.min(...prices) * entry.toBuy;
  }
  return totals;
}
