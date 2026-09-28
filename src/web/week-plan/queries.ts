import {
  and,
  asc,
  between,
  eq,
  exists,
  gte,
  inArray,
  isNull,
  lt,
  not,
  sql,
} from 'drizzle-orm';
import type { Queryable } from '../../db/client';
import {
  garment,
  garmentWear,
  outfit,
  outfitCalendar,
  outfitSlot,
  weekPlan,
  weekPlanEntry,
  weekReplan,
} from '../../db/schema';
import { washLimit } from '../../wardrobe/availability';
import type { Occasion } from '../../wardrobe/occasions';
import { categoryRole } from '../../wardrobe/properties';
import type { PlannedBy } from '../../wardrobe/week';
import type {
  OutfitGarmentState,
  PlannedNeeds,
  WeekEntry,
} from '../../wardrobe/week-planner';
import { matchGarment } from '../../weather/match';
import type { IsoDate } from '../calendar/calendar-date';
import { deleteOutfit } from '../outfits/queries';
import { outfitIsHeld } from '../outfits/references';
import { wearsSinceWashSql } from '../wears/queries';

/**
 * The weekly auto-plan's rows (#16): the calendar window the planner reads,
 * the batches ("Plan my week" taps) and what each auto entry was planned
 * for, and the daily re-plan's claims. The signed-in owner's own, like the
 * calendar. The writes here run inside plan.ts's and replan.ts's
 * transactions (under lockOwner), and pickIdea's (adoptPlannerOutfit);
 * calendar entries themselves are only ever written through insertEntry
 * (pickIdea) and removed by removeAutoEntries.
 */

/** A calendar entry in the planner's window: what week-planner.ts reads, and who planned it. */
export interface WindowEntry extends WeekEntry {
  outfitId: number;
  plannedBy: PlannedBy;
}

/**
 * The owner's entries from `first` to `last` (inclusive) with their
 * outfits' garments as the planner judges them (role, weather). One
 * statement, served by the unique (owner_id, day, outfit_id) index.
 */
export async function windowEntries(
  db: Queryable,
  ownerId: number,
  first: IsoDate,
  last: IsoDate,
): Promise<WindowEntry[]> {
  const rows = await db.query.outfitCalendar.findMany({
    columns: {
      id: true,
      day: true,
      occasion: true,
      wornAt: true,
      plannedBy: true,
      outfitId: true,
    },
    where: and(
      eq(outfitCalendar.ownerId, ownerId),
      between(outfitCalendar.day, first, last),
    ),
    orderBy: (entry, { asc }) => [asc(entry.day), asc(entry.id)],
    with: {
      outfit: {
        columns: {},
        with: {
          slots: {
            columns: {},
            where: (slot, { isNotNull }) => isNotNull(slot.garmentId),
            with: {
              garment: {
                columns: {
                  id: true,
                  category: true,
                  type: true,
                  fabricWeight: true,
                  warmth: true,
                  waterResistant: true,
                },
              },
            },
          },
        },
      },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    day: row.day,
    occasion: row.occasion,
    worn: row.wornAt !== null,
    plannedBy: row.plannedBy,
    outfitId: row.outfitId,
    garments: row.outfit.slots.flatMap(({ garment }) =>
      garment
        ? [
            {
              id: garment.id,
              role: categoryRole(garment.category),
              weather: matchGarment(garment),
            },
          ]
        : [],
    ),
  }));
}

/** An entry the planner wrote and still owns, with its batch and what it was planned for. */
export interface AutoEntryRow {
  entryId: number;
  day: IsoDate;
  outfitId: number;
  weekPlanId: number;
  outfitCreated: boolean;
  plannedFor: PlannedNeeds | null;
}

const entryColumns = {
  entryId: weekPlanEntry.entryId,
  day: outfitCalendar.day,
  outfitId: outfitCalendar.outfitId,
  weekPlanId: weekPlanEntry.weekPlanId,
  outfitCreated: weekPlanEntry.outfitCreated,
  torso: weekPlanEntry.torso,
  limbs: weekPlanEntry.limbs,
  layer: weekPlanEntry.layer,
  rain: weekPlanEntry.rain,
};

interface EntryRow extends Omit<AutoEntryRow, 'plannedFor'> {
  torso: number | null;
  limbs: number | null;
  layer: boolean | null;
  rain: boolean | null;
}

function autoEntryOf({
  torso,
  limbs,
  layer,
  rain,
  ...row
}: EntryRow): AutoEntryRow {
  return {
    ...row,
    // The check constraint keeps the four together.
    plannedFor:
      torso === null || limbs === null || layer === null || rain === null
        ? null
        : { torso, limbs, layer, rain },
  };
}

/**
 * The owner's auto entries (planned_by 'auto', not worn) from `from` on:
 * what the re-plan may judge. Entries the person has since edited or worn
 * are 'user' and never come back here.
 */
export async function autoEntries(
  db: Queryable,
  ownerId: number,
  from: IsoDate,
): Promise<AutoEntryRow[]> {
  const rows = await db
    .select(entryColumns)
    .from(weekPlanEntry)
    .innerJoin(outfitCalendar, eq(outfitCalendar.id, weekPlanEntry.entryId))
    .where(
      and(
        eq(outfitCalendar.ownerId, ownerId),
        eq(outfitCalendar.plannedBy, 'auto'),
        isNull(outfitCalendar.wornAt),
        gte(outfitCalendar.day, from),
      ),
    )
    .orderBy(outfitCalendar.day, outfitCalendar.id);
  return rows.map(autoEntryOf);
}

/** A new batch: one "Plan my week". */
export async function createWeekPlan(
  tx: Queryable,
  ownerId: number,
): Promise<number> {
  const [row] = await tx
    .insert(weekPlan)
    .values({ ownerId })
    .returning({ id: weekPlan.id });
  return row.id;
}

/** Whether batch `id` is the owner's (another's is a miss, like an unknown id). */
export async function weekPlanOf(
  db: Queryable,
  ownerId: number,
  id: number,
): Promise<boolean> {
  const [row] = await db
    .select({ id: weekPlan.id })
    .from(weekPlan)
    .where(and(eq(weekPlan.id, id), eq(weekPlan.ownerId, ownerId)));
  return row !== undefined;
}

/** Records an entry the planner just wrote. */
export async function recordAutoEntry(
  tx: Queryable,
  entry: {
    entryId: number;
    weekPlanId: number;
    outfitCreated: boolean;
    needs: PlannedNeeds | null;
  },
): Promise<void> {
  await tx.insert(weekPlanEntry).values({
    entryId: entry.entryId,
    weekPlanId: entry.weekPlanId,
    outfitCreated: entry.outfitCreated,
    ...needsColumns(entry.needs),
  });
}

/** The re-plan kept an entry under new targets: they are what it is judged against next. */
export async function updatePlannedNeeds(
  tx: Queryable,
  entryId: number,
  needs: PlannedNeeds,
): Promise<void> {
  await tx
    .update(weekPlanEntry)
    .set(needsColumns(needs))
    .where(eq(weekPlanEntry.entryId, entryId));
}

function needsColumns(needs: PlannedNeeds | null) {
  return needs ?? { torso: null, limbs: null, layer: null, rain: null };
}

/** A batch's entries the planner still owns: what Undo takes back. */
export async function batchAutoEntries(
  db: Queryable,
  weekPlanId: number,
): Promise<AutoEntryRow[]> {
  const rows = await db
    .select(entryColumns)
    .from(weekPlanEntry)
    .innerJoin(outfitCalendar, eq(outfitCalendar.id, weekPlanEntry.entryId))
    .where(
      and(
        eq(weekPlanEntry.weekPlanId, weekPlanId),
        eq(outfitCalendar.plannedBy, 'auto'),
      ),
    );
  return rows.map(autoEntryOf);
}

/**
 * Removes auto entries (only those still 'auto': one the person took over
 * meanwhile stays) and then each outfit the planner created for them that
 * no calendar entry holds any more, through deleteOutfit (its wears rule;
 * an auto entry has none, being unworn). An outfit the planner found
 * already saved is the person's and stays. Returns what went.
 */
export async function removeAutoEntries(
  tx: Queryable,
  ownerId: number,
  entries: readonly Pick<
    AutoEntryRow,
    'entryId' | 'outfitId' | 'outfitCreated'
  >[],
): Promise<{ entries: number; outfits: number }> {
  if (entries.length === 0) return { entries: 0, outfits: 0 };
  const deleted = await tx
    .delete(outfitCalendar)
    .where(
      and(
        inArray(
          outfitCalendar.id,
          entries.map((e) => e.entryId),
        ),
        eq(outfitCalendar.ownerId, ownerId),
        eq(outfitCalendar.plannedBy, 'auto'),
      ),
    )
    .returning({ id: outfitCalendar.id });
  const outfits = await removeUnheldOutfits(
    tx,
    ownerId,
    entries.filter((e) => e.outfitCreated).map((e) => e.outfitId),
  );
  return { entries: deleted.length, outfits };
}

/**
 * Deletes each of `outfitIds` (outfits the planner created, which the
 * caller has just taken off their entries) that nothing holds any more
 * (outfitIsHeld: no calendar entry, no trip), through deleteOutfit (its
 * wears rule). One held elsewhere, or one the planner found already saved
 * (never passed here), is the person's and stays. The one rule for Undo,
 * the re-plan's swap (removeAutoEntries) and changing an auto entry's
 * outfit (replaceEntryOutfit, #69). Returns how many went.
 *
 * The outfits are locked (FOR UPDATE, in id order) before the question is
 * asked: a trip or calendar row being added for one meanwhile needs the
 * outfit's key lock for its foreign key, so it either committed before the
 * lock (and is seen here) or waits and then fails on the deleted outfit,
 * never silently cascaded away.
 */
export async function removeUnheldOutfits(
  tx: Queryable,
  ownerId: number,
  outfitIds: readonly number[],
): Promise<number> {
  const candidates = [...new Set(outfitIds)];
  if (candidates.length === 0) return 0;
  const locked = await tx
    .select({ id: outfit.id })
    .from(outfit)
    .where(and(inArray(outfit.id, candidates), eq(outfit.ownerId, ownerId)))
    .orderBy(outfit.id)
    .for('update');
  if (locked.length === 0) return 0;
  const unheld = await tx
    .select({ id: outfit.id })
    .from(outfit)
    .where(
      and(
        inArray(
          outfit.id,
          locked.map((row) => row.id),
        ),
        not(outfitIsHeld(outfit.id)),
      ),
    );
  for (const { id } of unheld) await deleteOutfit(tx, id, ownerId);
  return unheld.length;
}

/**
 * Whether the planner created the outfit of auto entry `entryId` ("Plan my
 * week" found none saved of those garments): what makes it the planner's
 * to remove once nothing holds it. Asked only of an entry still 'auto'
 * (CLAUDE.md Gotchas: a taken-over entry's week_plan_entry row is
 * provenance, not ownership); false for an entry the planner never wrote.
 */
export async function plannerCreatedOutfit(
  tx: Queryable,
  entryId: number,
): Promise<boolean> {
  const [row] = await tx
    .select({ outfitCreated: weekPlanEntry.outfitCreated })
    .from(weekPlanEntry)
    .where(eq(weekPlanEntry.entryId, entryId));
  return row?.outfitCreated ?? false;
}

/**
 * The person picked outfit `outfitId` of garments the planner had already
 * saved as an outfit (pickIdea's reuse, "Already saved"): it is theirs now,
 * so no entry of it counts as planner-made any more and Undo, the re-plan's
 * swap and Change (removeUnheldOutfits) keep it once its entries go. The
 * entries themselves stay the planner's until the person touches them.
 * Runs in the pick's transaction, under lockOwner. Returns how many of the
 * planner's rows it took over (0 for an outfit the planner never made).
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

/** A garment of an auto entry's outfit, as the re-plan judges and names it. */
export interface SlotGarment extends OutfitGarmentState {
  name: string | null;
  category: string;
}

/**
 * The slots of `outfitIds` in order, each its garment's state today (the
 * garment's status and away, its wash state, whether it was worn today) or
 * null for an empty slot: what unwearableOn judges an auto entry by. One
 * statement; the wash counts are wearsSinceWashSql's, the laundry's rule.
 */
export async function outfitGarmentStates(
  db: Queryable,
  outfitIds: readonly number[],
  today: IsoDate,
): Promise<Map<number, (SlotGarment | null)[]>> {
  const outfits = new Map<number, (SlotGarment | null)[]>();
  if (outfitIds.length === 0) return outfits;
  const rows = await db
    .select({
      outfitId: outfitSlot.outfitId,
      id: garment.id,
      name: garment.name,
      category: garment.category,
      status: garment.status,
      away: garment.away,
      quantity: garment.quantity,
      washAfterWears: garment.washAfterWears,
      wearsSinceWash: wearsSinceWashSql(),
      // "Wore today" or a worn entry (the ledger's idleDays === 0).
      wornToday: sql<boolean>`exists (select 1 from ${garmentWear} where ${garmentWear.garmentId} = ${garment.id} and ${garmentWear.day} = ${today})`,
    })
    .from(outfitSlot)
    .leftJoin(garment, eq(garment.id, outfitSlot.garmentId))
    .where(inArray(outfitSlot.outfitId, [...new Set(outfitIds)]))
    .orderBy(asc(outfitSlot.outfitId), asc(outfitSlot.position));
  for (const row of rows) {
    const slots = outfits.get(row.outfitId) ?? [];
    slots.push(
      row.id === null
        ? null
        : {
            id: row.id,
            name: row.name,
            category: row.category!,
            status: row.status!,
            away: row.away,
            quantity: row.quantity!,
            limit: washLimit(row.category!, row.washAfterWears),
            wearsSinceWash: row.wearsSinceWash,
            wornToday: row.wornToday,
          },
    );
    outfits.set(row.outfitId, slots);
  }
  return outfits;
}

/** Deletes batch `id` once none of its entries is left (all undone or deleted). */
export async function deleteEmptyWeekPlan(
  tx: Queryable,
  id: number,
): Promise<void> {
  await tx
    .delete(weekPlan)
    .where(
      and(
        eq(weekPlan.id, id),
        sql`not exists (select 1 from ${weekPlanEntry} where ${weekPlanEntry.weekPlanId} = ${weekPlan.id})`,
      ),
    );
}

/** An entry of a batch as the calendar's banner lists it. */
export interface BatchEntry {
  entryId: number;
  day: IsoDate;
  occasion: Occasion;
  plannedBy: PlannedBy;
  outfitName: string | null;
}

/** Batch `id`'s entries still on the calendar (auto or taken over), by day. */
export async function batchEntries(
  db: Queryable,
  ownerId: number,
  id: number,
): Promise<BatchEntry[]> {
  return db
    .select({
      entryId: outfitCalendar.id,
      day: outfitCalendar.day,
      occasion: outfitCalendar.occasion,
      plannedBy: outfitCalendar.plannedBy,
      outfitName: outfit.name,
    })
    .from(weekPlanEntry)
    .innerJoin(outfitCalendar, eq(outfitCalendar.id, weekPlanEntry.entryId))
    .innerJoin(outfit, eq(outfit.id, outfitCalendar.outfitId))
    .where(
      and(
        eq(weekPlanEntry.weekPlanId, id),
        eq(outfitCalendar.ownerId, ownerId),
      ),
    )
    .orderBy(outfitCalendar.day, outfitCalendar.id);
}

// ---- The daily re-plan's claims ---------------------------------------------

/**
 * Who is due today's re-plan: an auto entry (unworn, recorded in a batch:
 * what autoEntries reads) from `day` on and no claim for the day. `userId` asks about one user (the morning reminder's
 * re-plan first); without it, every user (the minutely run). A read only:
 * the claim itself is claimReplan's, inside the work's transaction, so a
 * user listed here may still turn out to be re-planned by another run.
 */
export async function replanCandidates(
  db: Queryable,
  day: IsoDate,
  userId?: number,
): Promise<number[]> {
  const rows = await db
    .selectDistinct({ userId: outfitCalendar.ownerId })
    .from(outfitCalendar)
    .innerJoin(weekPlanEntry, eq(weekPlanEntry.entryId, outfitCalendar.id))
    .where(
      and(
        userId === undefined ? undefined : eq(outfitCalendar.ownerId, userId),
        eq(outfitCalendar.plannedBy, 'auto'),
        isNull(outfitCalendar.wornAt),
        gte(outfitCalendar.day, day),
        not(
          exists(
            db
              .select({ one: sql`1` })
              .from(weekReplan)
              .where(
                and(
                  eq(weekReplan.userId, outfitCalendar.ownerId),
                  eq(weekReplan.day, day),
                ),
              ),
          ),
        ),
      ),
    )
    .orderBy(outfitCalendar.ownerId);
  return rows.map((row) => row.userId);
}

/**
 * Claims `userId`'s re-plan for `day`: true when this call inserted the
 * (user, day) row, false when it was there. Called inside the re-plan's own
 * transaction, under lockOwner, so the claim commits with the work: whoever
 * finds it claimed finds the re-plan done, never half done (a second server,
 * the morning reminder's re-plan first). Also called in a transaction of
 * its own (under the owner lock too) after a failed re-plan, so a user
 * whose re-plan throws is tried once a day, not every minute.
 */
export async function claimReplan(
  db: Queryable,
  userId: number,
  day: IsoDate,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .insert(weekReplan)
    .values({ userId, day, claimedAt: now })
    .onConflictDoNothing({ target: [weekReplan.userId, weekReplan.day] })
    .returning({ userId: weekReplan.userId });
  return rows.length > 0;
}

/** Removes claims of days before `before`: a claim only ever guards its own day. */
export async function pruneReplanClaims(
  db: Queryable,
  before: IsoDate,
): Promise<number> {
  const deleted = await db
    .delete(weekReplan)
    .where(lt(weekReplan.day, before))
    .returning({ userId: weekReplan.userId });
  return deleted.length;
}
