import {
  type ComparedItem,
  comparePlans,
  type ItemStatus,
  PLAN_PRIORITIES,
  type PlanComparison,
} from '../../wardrobe/plans';
import { type PlanGaps, toTarget } from './gaps';
import type { PlanItemRow } from './queries';

/** An item as a comparison shows it: its row, and its status in its own plan. */
export interface ComparedRow extends ComparedItem {
  row: PlanItemRow;
  status: ItemStatus;
}

const STATUSES: readonly ItemStatus[] = ['missing', 'partly', 'owned'];

/** A plan's accepted items as the comparison reads them, in priority then age order. */
function comparedRows(gaps: PlanGaps): ComparedRow[] {
  const priority = (row: ComparedRow) => PLAN_PRIORITIES.indexOf(row.priority);
  return STATUSES.flatMap((status) =>
    gaps.groups[status].map(({ item }) => ({
      ...toTarget(item),
      row: item,
      status,
    })),
  ).sort((x, y) => priority(x) - priority(y) || x.id - y.id);
}

/**
 * Two measured plans (allPlanGaps) compared item by item (comparePlans):
 * the compare page's model and compare_plans's (MCP). Accepted items only:
 * a proposal is not part of a plan until the owner accepts it.
 */
export function planComparison(
  a: PlanGaps,
  b: PlanGaps,
): PlanComparison<ComparedRow> {
  return comparePlans(comparedRows(a), comparedRows(b));
}
