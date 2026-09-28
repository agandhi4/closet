import type { Db } from '../../db/client';
import {
  findPlan,
  findPlanItem,
  type PlanDetail,
  type PlanItemRow,
} from './queries';
import { itemNotFound, planNotFound } from './validation';

/**
 * The routes' lookups of a plan or an item by the ids in their path: the
 * signed-in owner's, or a 404 like an unknown id (plans are private, so
 * another user's is exactly that). Shared by the plan routes and the
 * shopping loop's (routes.tsx, shopping-routes.tsx).
 */

export async function requirePlan(
  db: Db,
  userId: number,
  planId: number,
): Promise<PlanDetail> {
  const plan = await findPlan(db, planId, userId);
  if (!plan) throw planNotFound();
  return plan;
}

/** Both in one statement (findPlanItem), each miss with its own 404. */
export async function requirePlanItem(
  db: Db,
  userId: number,
  planId: number,
  itemId: number,
): Promise<{ plan: PlanDetail; item: PlanItemRow }> {
  const found = await findPlanItem(db, planId, itemId, userId);
  if (!found) throw planNotFound();
  if (!found.item) throw itemNotFound();
  return { plan: found.plan, item: found.item };
}
