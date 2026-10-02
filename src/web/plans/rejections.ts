import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { Queryable } from '../../db/client';
import { planItem, planItemRejection } from '../../db/schema';
import type { CandidateGarment } from './candidates';

/**
 * Products the owner turned down for a plan item ("Not this one" on the
 * plan review, #278): a snapshot of the candidate as it was and the
 * owner's reason, kept in plan_item_rejection for the agent
 * (get_plan_gaps' `rejected`), so it never adds the product again. The
 * candidate itself goes through the review's removal rule (review.ts):
 * deleted from the wishlist when it stands for nothing else, else unlinked
 * from the item. Rows go with their item; a duplicated plan copies them.
 * The owner's own like the plan: read only for items the caller found to
 * be theirs.
 */

export interface Rejection {
  itemId: number;
  name: string | null;
  brand: string | null;
  url: string | null;
  price: string | null;
  reason: string | null;
  at: Date;
}

const REJECTION_COLUMNS = {
  itemId: planItemRejection.planItemId,
  name: planItemRejection.name,
  brand: planItemRejection.brand,
  url: planItemRejection.url,
  price: planItemRejection.price,
  reason: planItemRejection.reason,
  at: planItemRejection.createdAt,
};

/** The rejections of plan `planId`'s items (the owner's, checked by the caller), by item, oldest first. One statement. */
export async function rejectionsOfPlan(
  db: Queryable,
  planId: number,
): Promise<Map<number, Rejection[]>> {
  const rows = await db
    .select(REJECTION_COLUMNS)
    .from(planItemRejection)
    .innerJoin(planItem, eq(planItem.id, planItemRejection.planItemId))
    .where(eq(planItem.planId, planId))
    .orderBy(asc(planItemRejection.createdAt), asc(planItemRejection.id));
  const byItem = new Map<number, Rejection[]>();
  for (const row of rows) {
    const list = byItem.get(row.itemId);
    if (list) list.push(row);
    else byItem.set(row.itemId, [row]);
  }
  return byItem;
}

/** A candidate turned down, with the owner's reason (null: none given). */
export interface RejectedCandidate {
  candidate: CandidateGarment;
  reason: string | null;
}

/** Records `rejected` against their items, as each candidate stands now. One statement. */
export async function recordRejections(
  tx: Queryable,
  rejected: readonly RejectedCandidate[],
): Promise<void> {
  if (rejected.length === 0) return;
  await tx.insert(planItemRejection).values(
    rejected.map(({ candidate, reason }) => ({
      planItemId: candidate.itemId,
      name: candidate.name,
      brand: candidate.brand,
      url: candidate.sourceUrl,
      price: candidate.price,
      reason,
    })),
  );
}

/**
 * Copies each original item's rejections to its copy (a duplicated plan,
 * `copies` mapping original id to copy id), their times kept. One
 * statement however many.
 */
export async function copyRejections(
  tx: Queryable,
  copies: ReadonlyMap<number, number>,
): Promise<void> {
  if (copies.size === 0) return;
  const originals = [...copies.keys()];
  await tx.execute(sql`
    insert into ${planItemRejection}
      (plan_item_id, name, brand, url, price, reason, created_at)
    select case ${planItemRejection.planItemId} ${sql.join(
      [...copies].map(([from, to]) => sql`when ${from} then ${to}::integer`),
      sql` `,
    )} end,
      ${planItemRejection.name}, ${planItemRejection.brand}, ${planItemRejection.url},
      ${planItemRejection.price}, ${planItemRejection.reason}, ${planItemRejection.createdAt}
    from ${planItemRejection}
    where ${inArray(planItemRejection.planItemId, originals)}
    order by ${planItemRejection.id}`);
}
