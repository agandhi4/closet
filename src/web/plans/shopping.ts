import type { Db } from '../../db/client';
import { targetDifferences, type TargetDifference } from '../../wardrobe/plans';
import {
  type ShoppingEntry,
  shoppingList,
  type ShoppingTotals,
  shoppingTotals,
} from '../../wardrobe/shopping';
import { type CandidateGarment, candidatesOfPlan } from './candidates';
import { planGaps, type PlanGaps, toTarget } from './gaps';
import type { PlanDetail, PlanItemRow } from './queries';

/**
 * A plan's shopping list (#34, slice 34b), as the page and get_shopping_list
 * (MCP) read it: the gap view's items (planGaps) and each item's candidate
 * products (candidatesOfPlan), run through shoppingList
 * (src/wardrobe/shopping.ts), each candidate judged against its item. Three
 * statements: the items, the closet, the candidates.
 */

/** A candidate as the list shows it: the product, and how it fits its item. */
export interface ListedCandidate extends CandidateGarment {
  matches: boolean;
  /** How it falls outside the item (targetDifferences); empty when it matches. */
  differences: TargetDifference[];
}

export interface PlanShoppingList {
  gaps: PlanGaps;
  entries: ShoppingEntry<PlanItemRow, ListedCandidate>[];
  totals: ShoppingTotals;
}

export async function planShoppingList(
  db: Db,
  plan: PlanDetail,
  ownerId: number,
): Promise<PlanShoppingList> {
  const [gaps, candidates] = await Promise.all([
    planGaps(db, plan, ownerId),
    candidatesOfPlan(db, ownerId, plan.id),
  ]);
  const items = new Map(
    [...gaps.groups.missing, ...gaps.groups.partly].map(({ item }) => [
      item.id,
      item,
    ]),
  );
  const listed = (itemId: number): ListedCandidate[] =>
    (candidates.get(itemId) ?? []).map((candidate) => {
      const differences = targetDifferences(
        toTarget(items.get(itemId)!),
        candidate,
      );
      return { ...candidate, matches: differences.length === 0, differences };
    });
  const entries = shoppingList(
    [...gaps.groups.missing, ...gaps.groups.partly],
    listed,
  );
  return { gaps, entries, totals: shoppingTotals(entries) };
}
