import { and, between, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Queryable } from '../../db/client';
import {
  outfit,
  outfitCalendar,
  weekPlan,
  weekPlanEntry,
  weekReplan,
} from '../../db/schema';
import type { Occasion } from '../../wardrobe/occasions';
import { categoryRole } from '../../wardrobe/properties';
import type { PlannedBy } from '../../wardrobe/week';
import type { PlannedNeeds, WeekEntry } from '../../wardrobe/week-planner';
import { matchGarment } from '../../weather/match';
import type { IsoDate } from '../calendar/calendar-date';
import { deleteOutfit } from '../outfits/queries';

/**
 * The weekly auto-plan's rows (#16): the calendar window the planner reads,
 * the batches ("Plan my week" taps) and what each auto entry was planned
 * for, and the daily re-plan's claims. The signed-in owner's own, like the
 * calendar. The writes here run inside plan.ts's and replan.ts's
 * transactions (under lockOwner); calendar entries themselves are only ever
 * written through insertEntry (pickIdea) and removed by removeAutoEntries.
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
  const created = [
    ...new Set(entries.filter((e) => e.outfitCreated).map((e) => e.outfitId)),
  ];
  const unused =
    created.length === 0
      ? []
      : await tx
          .select({ id: outfit.id })
          .from(outfit)
          .where(
            and(
              inArray(outfit.id, created),
              eq(outfit.ownerId, ownerId),
              sql`not exists (select 1 from ${outfitCalendar} where ${outfitCalendar.outfitId} = ${outfit.id})`,
            ),
          );
  for (const { id } of unused) await deleteOutfit(tx, id, ownerId);
  return { entries: deleted.length, outfits: unused.length };
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
 * Claims today's re-plan for every user with an auto entry from today on,
 * in one statement: a (user, day) row is inserted unless one exists, and
 * only the users inserted come back. Two servers (or two minutes) claiming
 * at once each insert; Postgres makes the second wait on the first's key
 * and skip it, so each user is re-planned once a day (the reminders'
 * claim, src/web/push/queries.ts claimReminders).
 */
export async function claimReplans(
  db: Queryable,
  day: IsoDate,
  now: Date,
): Promise<number[]> {
  const rows = await db
    .insert(weekReplan)
    .select(
      db
        .selectDistinct({
          userId: outfitCalendar.ownerId,
          day: sql<IsoDate>`${day}::date`.as('day'),
          claimedAt: sql<Date>`${now.toISOString()}::timestamptz`.as(
            'claimed_at',
          ),
        })
        .from(outfitCalendar)
        .where(
          and(
            eq(outfitCalendar.plannedBy, 'auto'),
            isNull(outfitCalendar.wornAt),
            gte(outfitCalendar.day, day),
          ),
        ),
    )
    .onConflictDoNothing({ target: [weekReplan.userId, weekReplan.day] })
    .returning({ userId: weekReplan.userId });
  return rows.map((row) => row.userId).sort((a, b) => a - b);
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
