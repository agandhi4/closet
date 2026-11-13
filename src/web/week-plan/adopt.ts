import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Queryable } from '../../db/client';
import { outfit, outfitCalendar, weekPlanEntry } from '../../db/schema';
import {
  OUTFIT_ORIGINS,
  type OutfitOrigin,
} from '../../wardrobe/outfit-origin';

/**
 * A save of garments that were already outfit `outfitId` (createOutfit's
 * reuse, "Already saved": a pick, the outfit form, create_outfit), made
 * with `origin`, takes the outfit over as far as that origin reaches:
 *
 * - its origin moves up to the saver's (#659: OUTFIT_ORIGINS' rank, never
 *   down), so a person's or the agent's save of a one-off puts it on
 *   Saved, and an idea pick of a planner outfit takes it from the planner;
 * - no entry of it counts as planner-made any more (#77: its
 *   week_plan_entry.outfit_created rows cleared), so Undo, the re-plan's
 *   swap, Change and the calendar's x (removeUnheldOutfits) keep it once
 *   its entries go. The entries themselves stay the planner's until the
 *   person touches them.
 *
 * The planner's own reuse (`origin` 'planner') changes nothing: callers
 * skip it. One statement (the outfit update is a data-modifying CTE,
 * which Postgres runs though nothing reads it). Runs in the save's
 * transaction, under lockOwner. Returns how many of the planner's rows it
 * took over (0 for an outfit the planner never made).
 *
 * A module of its own (not queries.ts) because createOutfit
 * (src/web/outfits/queries.ts) calls it, and week-plan/queries.ts imports
 * the outfit writers.
 */
export async function adoptOutfit(
  tx: Queryable,
  ownerId: number,
  outfitId: number,
  origin: OutfitOrigin,
): Promise<number> {
  const rank = sql`array[${sql.join(
    OUTFIT_ORIGINS.map((o) => sql`${o}`),
    sql`, `,
  )}]::text[]`;
  const promoted = tx
    .update(outfit)
    .set({ origin })
    .where(
      and(
        eq(outfit.id, outfitId),
        eq(outfit.ownerId, ownerId),
        sql`array_position(${rank}, ${outfit.origin}) > array_position(${rank}, ${origin}::text)`,
      ),
    );
  const released = tx
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
  // getSQL(): Drizzle wraps an embedded builder in parentheses, which
  // Postgres takes around a select but not around an update.
  const { rows } = await tx.execute<{ entryId: number }>(sql`
    with promoted as (${promoted.getSQL()})
    ${released.getSQL()}`);
  return rows.length;
}
