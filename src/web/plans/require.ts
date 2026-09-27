import type { Db } from '../../db/client';
import {
  findItem,
  findPlan,
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

export async function requirePlanItem(
  db: Db,
  userId: number,
  planId: number,
  itemId: number,
): Promise<{ plan: PlanDetail; item: PlanItemRow }> {
  const plan = await requirePlan(db, userId, planId);
  const item = await findItem(db, itemId, plan.id, userId);
  if (!item) throw itemNotFound();
  return { plan, item };
}
