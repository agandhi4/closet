import type { Db } from '../../db/client';
import { isAccepted, type PlanItemReview } from '../../wardrobe/plan-review';
import {
  type ItemMatch,
  type ItemStatus,
  matchPlan,
  PLAN_PRIORITIES,
  type PlanTarget,
  planTally,
} from '../../wardrobe/plans';
import {
  type ClosetGarment,
  closetPieces,
  itemsOf,
  listPlans,
  type PlanDetail,
  type PlanItemRow,
} from './queries';

/**
 * A plan measured against its owner's closet: the gap view's model, and
 * get_plan_gaps's and list_plans's (src/web/mcp/tools/plans.ts). Reads the
 * items and the closet (two statements, whatever the plan's size) and runs
 * matchPlan (src/wardrobe/plans.ts); nothing is stored.
 */

/** The reviews outside the plan: shown apart, never matched. */
export type OpenReview = Exclude<PlanItemReview, 'accepted'>;

/** An accepted item and how the closet answers it. */
export interface GapItem {
  item: PlanItemRow;
  match: ItemMatch;
}

export interface PlanGaps {
  plan: PlanDetail;
  /** Accepted items, each group in priority then age order. */
  groups: Record<ItemStatus, GapItem[]>;
  tally: Record<ItemStatus, number>;
  /**
   * Items not part of the plan (yet), by review, each in priority then age
   * order: the agent's proposals, those the owner sent back with a note
   * (revise), and those declined. None is matched.
   */
  review: Record<OpenReview, PlanItemRow[]>;
  /** The closet's garments by id, for the names and photos a match points at. */
  closet: Map<number, ClosetGarment>;
}

/** A stored item as matching reads it. */
export function toTarget(item: PlanItemRow): PlanTarget {
  return {
    id: item.id,
    category: item.category,
    type: item.type,
    colors: item.colors ?? [],
    materials: item.materials ?? [],
    warmth:
      item.warmthMin === null || item.warmthMax === null
        ? null
        : { min: item.warmthMin, max: item.warmthMax },
    formality:
      item.formalityMin === null || item.formalityMax === null
        ? null
        : { min: item.formalityMin, max: item.formalityMax },
    quantity: item.quantity,
    priority: item.priority,
  };
}

/** What Review (#271) opens: the plan's proposed items and proposed looks (#291). The one rule behind the plan page, the list and Today's card (waitingDraftsSql counts the same in SQL). */
export function awaitingReview(gaps: PlanGaps): number {
  return gaps.review.proposed.length + gaps.plan.proposedLooks;
}

const PRIORITY_ORDER: readonly string[] = PLAN_PRIORITIES;

/** Highest priority first, then oldest: the gap view's groups and the plan review (#271). */
export function byPriority(a: PlanItemRow, b: PlanItemRow): number {
  return (
    PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority) ||
    a.id - b.id
  );
}

/** The plan's accepted items in priority order, each matched against the closet: the one rule behind the gap view and the shopping strip. */
function matchAccepted(items: PlanItemRow[], closet: ClosetGarment[]) {
  const accepted = [...items]
    .sort(byPriority)
    .filter((item) => isAccepted(item.review));
  return { accepted, matches: matchPlan(accepted.map(toTarget), closet) };
}

/**
 * The ids of plan `planId`'s accepted items still missing or partly owned,
 * the items the shopping strip lists (planShoppingList). Two statements.
 */
export async function itemsToBuy(
  db: Db,
  planId: number,
  ownerId: number,
): Promise<Set<number>> {
  const [items, closet] = await Promise.all([
    itemsOf(db, [planId]),
    closetPieces(db, ownerId),
  ]);
  const { accepted, matches } = matchAccepted(items, closet);
  return new Set(
    accepted
      .filter((_, index) => matches[index].status !== 'owned')
      .map((item) => item.id),
  );
}

function measure(
  plan: PlanDetail,
  items: PlanItemRow[],
  closet: ClosetGarment[],
): PlanGaps {
  const sorted = [...items].sort(byPriority);
  const { accepted, matches } = matchAccepted(items, closet);
  const groups: Record<ItemStatus, GapItem[]> = {
    owned: [],
    partly: [],
    missing: [],
  };
  accepted.forEach((item, index) => {
    const match = matches[index];
    groups[match.status].push({ item, match });
  });
  return {
    plan,
    groups,
    tally: planTally(matches),
    review: {
      proposed: sorted.filter((item) => item.review === 'proposed'),
      revise: sorted.filter((item) => item.review === 'revise'),
      declined: sorted.filter((item) => item.review === 'declined'),
    },
    closet: new Map(closet.map((garment) => [garment.id, garment])),
  };
}

/** Plan `plan` (the owner's, found by the caller) against `ownerId`'s closet. */
export async function planGaps(
  db: Db,
  plan: PlanDetail,
  ownerId: number,
): Promise<PlanGaps> {
  const [items, closet] = await Promise.all([
    itemsOf(db, [plan.id]),
    closetPieces(db, ownerId),
  ]);
  return measure(plan, items, closet);
}

/** Every plan of the owner's, active first, each measured: the list page and list_plans. */
export async function allPlanGaps(
  db: Db,
  ownerId: number,
): Promise<PlanGaps[]> {
  const plans = await listPlans(db, ownerId);
  if (plans.length === 0) return [];
  const [items, closet] = await Promise.all([
    itemsOf(
      db,
      plans.map((plan) => plan.id),
    ),
    closetPieces(db, ownerId),
  ]);
  return plans.map((plan) =>
    measure(
      plan,
      items.filter((item) => item.planId === plan.id),
      closet,
    ),
  );
}
