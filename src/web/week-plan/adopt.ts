import { and, eq, inArray } from 'drizzle-orm';
import type { Queryable } from '../../db/client';
import { outfitCalendar, weekPlanEntry } from '../../db/schema';

/**
 * A person's save of garments the week planner had already saved as an
 * outfit (createOutfit's reuse, "Already saved": a pick, the outfit form,
 * create_outfit) takes outfit `outfitId` over (#77): no entry of it counts
 * as planner-made any more, so Undo, the re-plan's swap and Change
 * (removeUnheldOutfits) keep it once its entries go. The entries themselves
 * stay the planner's until the person touches them. Runs in the save's
 * transaction, under lockOwner. Returns how many of the planner's rows it
 * took over (0 for an outfit the planner never made).
 *
 * A module of its own (not queries.ts) because createOutfit
 * (src/web/outfits/queries.ts) calls it, and week-plan/queries.ts imports
 * the outfit writers.
 */
export async function adoptPlannerOutfit(
  tx: Queryable,
  ownerId: number,
  outfitId: number,
): Promise<number> {
  const adopted = await tx
    .update(weekPlanEntry)
    .set({ outfitCreated: false })
    .where(
      and(
        eq(weekPlanEntry.outfitCreated, true),
        inArray(
          weekPlanEntry.entryId,
          tx
            .select({ id: outfitCalendar.id })
            .from(outfitCalendar)
            .where(
              and(
                eq(outfitCalendar.ownerId, ownerId),
                eq(outfitCalendar.outfitId, outfitId),
              ),
            ),
        ),
      ),
    )
    .returning({ entryId: weekPlanEntry.entryId });
  return adopted.length;
}
