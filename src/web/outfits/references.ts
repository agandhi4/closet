import { type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { outfitCalendar, tripOutfit } from '../../db/schema';

/**
 * What holds an outfit: a calendar entry (any day, worn or not) and a trip
 * (#10). The one list, like photoIsReferenced (src/web/files/references.ts)
 * for photos. "Delete an outfit once nothing holds it" (the planner's
 * outfits, removeUnheldOutfits: Undo, the re-plan's swap, Change) asks
 * this, because deleteOutfit cascades every holder: a holder missing here
 * is a row silently deleted with the outfit (a trip lost its outfit and
 * its packing list that way). A new table with an `outfit_id` must be
 * added here. Its slots (outfit_slot) are its own parts, not holders, and
 * a plan look saved as it (plan_look.outfit_id, #292) is not one either:
 * that link is ON DELETE SET NULL and the look offers Save again, so
 * looks stay out of the deletion and week-planner rules (owner decision).
 * Were one added, its nullable column would need `is not null` here, or
 * `not in` is null and nothing is ever removed.
 *
 * Uncorrelated on purpose, for the reason photoIsReferenced gives: in a
 * single-table select drizzle writes a SQL field's columns without their
 * table, so a correlated `outfit_calendar.outfit_id = outfit.id` would
 * compare outfit_calendar's own columns. Both columns are not null, so
 * `not in` is never null.
 */
export function outfitIsHeld(outfitId: AnyPgColumn): SQL<boolean> {
  return sql<boolean>`(${outfitId} in (select ${outfitCalendar.outfitId} from ${outfitCalendar} union all select ${tripOutfit.outfitId} from ${tripOutfit}))`;
}
