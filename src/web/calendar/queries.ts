import { and, type AnyColumn, eq, type SQL, sql } from 'drizzle-orm';
import type { Db, Queryable } from '../../db/client';
import {
  file,
  garment,
  outfit,
  outfitCalendar,
  outfitSlot,
} from '../../db/schema';
import { selectScalars } from '../../db/select-scalars';
import type { Occasion } from '../../wardrobe/occasions';
import { DEFAULT_PLANNED_BY, type PlannedBy } from '../../wardrobe/week';
import { ownerTransaction } from '../auth/queries';
import { photoRefJson } from '../files/queries';
import { OutfitIncomplete } from '../outfits/gone-garments';
import {
  outfitIsComplete,
  type PieceToBuy,
  piecesToBuySql,
} from '../outfits/references';
import { deleteEntrySelfie, entrySelfieSql } from '../selfies/queries';
import {
  changeEntryWorn,
  type EntryWornOutcome,
  type LockedEntry,
} from '../wears/queries';
import type { IsoDate } from './calendar-date';
import type { CalendarEntry } from './calendar-view';

/**
 * The calendar's reads and writes. Every one is scoped to the signed-in
 * owner: outfits and calendar entries are private whatever wardrobe shares
 * exist. An entry that is not the caller's is a miss, the same as one that
 * does not exist: the route answers 404 either way, so entry ids reveal
 * nothing about other users (WardrobeAccess, src/web/sharing/access.ts).
 * Every write holds the owner lock (ownerTransaction; CLAUDE.md, Owner
 * lock): the re-plan and a replace judge several entries at once, and a
 * write that slipped between their read and their write would be lost or
 * would break the unique key.
 */

export type EntryMiss = 'not-found';

/**
 * The owner's entries from `first` to `last` (inclusive), by day then id,
 * each with its selfie and its outfit's garments for the collage (in the
 * order the outfit was built; empty slots have nothing to show); the pages
 * put a day's entries in occasion order (buildCalendarView, Today's
 * todayFor). A scalar subquery (a JSON list), so the week page reads it in
 * one statement with the rest of what it shows (weekContext); findEntries
 * reads it alone. Served by outfit_calendar_owner_id_day_outfit_id_unique
 * (owner_id, day). Every table appears once in each scope, so the columns
 * need no aliases: the selfie's `file` and the garments' are in sibling
 * subqueries.
 */
export function entriesSql(
  ownerId: number,
  first: IsoDate,
  last: IsoDate,
): SQL<CalendarEntry[]> {
  return sql<CalendarEntry[]>`(
    select coalesce(json_agg(json_build_object(
      'id', ${outfitCalendar.id},
      'day', ${outfitCalendar.day},
      'occasion', ${outfitCalendar.occasion},
      'worn', ${outfitCalendar.wornAt} is not null,
      'plannedBy', ${outfitCalendar.plannedBy},
      'selfie', ${entrySelfieSql(outfitCalendar.id)},
      'outfit', json_build_object(
        'id', ${outfit.id},
        'name', ${outfit.name},
        'garments', (
          select coalesce(json_agg(json_build_object(
            'id', ${garment.id},
            'name', ${garment.name},
            'category', ${garment.category},
            'photo', ${photoRefJson}
          ) order by ${outfitSlot.position}), '[]')
          from ${outfitSlot}
          inner join ${garment} on ${garment.id} = ${outfitSlot.garmentId}
          left join ${file} on ${file.id} = ${garment.photoId}
          where ${outfitSlot.outfitId} = ${outfit.id}
        )
      )
    ) order by ${outfitCalendar.day}, ${outfitCalendar.id}), '[]')
    from ${outfitCalendar}
    inner join ${outfit} on ${outfit.id} = ${outfitCalendar.outfitId}
    where ${outfitCalendar.ownerId} = ${ownerId}
      and ${outfitCalendar.day} between ${first} and ${last})`;
}

/** entriesSql alone: Today, the month, get_calendar. One statement. */
export async function findEntries(
  db: Queryable,
  ownerId: number,
  first: IsoDate,
  last: IsoDate,
): Promise<CalendarEntry[]> {
  const { entries } = await selectScalars(db, {
    entries: entriesSql(ownerId, first, last),
  });
  return entries;
}

/** An entry of a day as a picker reads it (entriesOfDaySql). */
export interface DayEntry {
  id: number;
  occasion: Occasion;
  outfitId: number;
  outfitName: string | null;
  /** Marked worn (worn_at set). */
  worn: boolean;
}

/**
 * The owner's entries on `day`, bare: which outfits are on it and for which
 * occasion, and each entry's outfit name and worn state. What picking an
 * outfit for the day needs (dayChoice), without findEntries' collages and
 * selfies, which no picker draws (#165). A scalar subquery (a JSON list),
 * so the Saved tab reads it in one statement with its grid (#164,
 * savedContext in src/web/outfits/page-context.ts). `ownerId` may be an
 * outer query's column: the evening reminders read every person's day in
 * one statement (eveningDays, src/web/today/queries.ts; #173).
 */
export function entriesOfDaySql(
  ownerId: number | AnyColumn,
  day: IsoDate,
): SQL<DayEntry[]> {
  return sql<DayEntry[]>`(
    select coalesce(json_agg(json_build_object(
      'id', ${outfitCalendar.id},
      'occasion', ${outfitCalendar.occasion},
      'outfitId', ${outfitCalendar.outfitId},
      'outfitName', ${outfit.name},
      'worn', ${outfitCalendar.wornAt} is not null
    )), '[]')
    from ${outfitCalendar}
    inner join ${outfit} on ${outfit.id} = ${outfitCalendar.outfitId}
    where ${outfitCalendar.ownerId} = ${ownerId}
      and ${outfitCalendar.day} = ${day})`;
}

export type ScheduleOutcome = 'scheduled' | 'already-scheduled';

/** An entry to plan: the owner's outfit on a day, for an occasion. */
export interface NewEntry {
  ownerId: number;
  outfitId: number;
  day: IsoDate;
  occasion: Occasion;
  /** The week planner's entries are 'auto' (#16); everything else is the person's (the default). */
  plannedBy?: PlannedBy;
}

/**
 * What insertEntry did: a new entry's id, for a caller that marks it worn
 * (the seed); for one already there, whether the person's write took it
 * over from the week planner (`adopted`).
 */
export type Scheduled =
  | { outcome: 'scheduled'; id: number }
  | { outcome: 'already-scheduled'; adopted: boolean };

/**
 * Plans the owner's outfit on `day` for an occasion. Idempotent: planning
 * the same outfit on the same day again inserts nothing (the unique
 * (owner, day, outfit) constraint), whatever the occasion, and reports
 * 'already-scheduled', so a double tap or a replayed form is not an error.
 * The ownership check and the write are one step under the owner lock, so
 * a replace or a re-plan never sees the day half changed. Answers the
 * occasion the outfit is on that day: the one asked, or the one it kept.
 * The check reads it with the outfit (#172: schedule_outfit read the whole
 * day's entries again after the write to say which), and the lock keeps it
 * true until the insert.
 */
export function scheduleOutfit(
  db: Queryable,
  entry: NewEntry,
): Promise<(Scheduled & { occasion: Occasion }) | 'no-such-outfit'> {
  return ownerTransaction(db, entry.ownerId, 'scheduleOutfit', async (tx) => {
    // The outfit is on a day once (the unique owner, day, outfit key): one row.
    const [owned] = await tx
      .select({ kept: outfitCalendar.occasion })
      .from(outfit)
      .leftJoin(
        outfitCalendar,
        and(
          eq(outfitCalendar.outfitId, outfit.id),
          eq(outfitCalendar.ownerId, entry.ownerId),
          eq(outfitCalendar.day, entry.day),
        ),
      )
      .where(
        and(eq(outfit.id, entry.outfitId), eq(outfit.ownerId, entry.ownerId)),
      );
    if (!owned) return 'no-such-outfit';
    const scheduled = await insertEntry(tx, entry);
    return { ...scheduled, occasion: owned.kept ?? entry.occasion };
  });
}

/** Whether `outfitId` is the owner's: outfits are private, another's is a miss. */
export async function ownsOutfit(
  db: Queryable,
  ownerId: number,
  outfitId: number,
): Promise<boolean> {
  const [owned] = await db
    .select({ id: outfit.id })
    .from(outfit)
    .where(and(eq(outfit.id, outfitId), eq(outfit.ownerId, ownerId)));
  return owned !== undefined;
}

/**
 * The one writer of calendar entries, for an outfit the caller has already
 * found to be the owner's: POST /calendar (scheduleOutfit), the outfit
 * form's "Add to calendar", inside its save transaction
 * (src/web/outfits/queries.ts), the gallery's pick (which the week planner,
 * #16, calls with plannedBy 'auto') and the seed's simulated history. An entry
 * starts unworn: setEntryWorn's change (changeEntryWorn, src/web/wears/queries.ts)
 * is the only way to mark one, because its wear rows change with it; "Wearing
 * this" plans through its own form of this insert (planToWear), which takes
 * the entry over as marking it does.
 *
 * The outfit already on that day keeps its entry and its occasion: planning
 * it again for another occasion changes nothing (an edit form re-saved with
 * the occasion picker at its default must not move an evening entry to all
 * day). Different outfits on one day are separate entries; changing the
 * outfit of an entry is setEntryOutfit's, through replaceEntryOutfit (#69).
 *
 * **The person planning what the week planner planned takes it over** (#77):
 * a `user` write that meets an `auto` entry of the same outfit on the day
 * sets it to `user` (and nothing else), so the re-plan and Undo leave the
 * choice the person just made; the planner's own `auto` write never
 * downgrades a person's entry. Both still answer 'already-scheduled'.
 *
 * Under the owner lock (ownerTransaction: a savepoint in the caller's
 * transaction, the lock free when the caller took it already). Without it
 * a take-over could commit between the re-plan's read of the entry as
 * `auto` and its swap, leaving two outfits in one slot (#122).
 *
 * **An incomplete outfit is refused** (#335: it holds a piece not bought
 * yet; src/web/outfits/references.ts): OutfitIncomplete, a 409 naming the
 * pieces, and nothing is written. The owner lock keeps it true until the
 * commit: a slot write that would add a piece (updateOutfit) takes it too.
 */
export function insertEntry(
  db: Queryable,
  entry: NewEntry,
): Promise<Scheduled> {
  return ownerTransaction(db, entry.ownerId, 'insertEntry', (tx) =>
    upsertEntry(tx, entry),
  );
}

async function upsertEntry(tx: Queryable, entry: NewEntry): Promise<Scheduled> {
  const outfitId = sql`${entry.outfitId}::int`;
  // A conflict the WHERE refuses returns no row, as does an incomplete
  // outfit's insert: `toBuy` (read in the same snapshot) tells them apart.
  // xmax is 0 on a row this statement inserted and set on one it updated:
  // Postgres' way of telling the two apart in one ON CONFLICT statement.
  const { rows } = await tx.execute<{
    id: number | null;
    inserted: boolean | null;
    toBuy: PieceToBuy[];
  }>(sql`
    with written as (
      insert into ${outfitCalendar} (owner_id, day, outfit_id, occasion, planned_by)
      select ${entry.ownerId}::int, ${entry.day}::date, ${outfitId},
        ${entry.occasion}::text, ${entry.plannedBy ?? DEFAULT_PLANNED_BY}::text
      where ${outfitIsComplete(outfitId)}
      on conflict (owner_id, day, outfit_id) do update set planned_by = 'user'
        where ${outfitCalendar.plannedBy} = 'auto' and excluded.planned_by = 'user'
      returning ${outfitCalendar.id} as id, (xmax = 0) as inserted
    )
    select (select id from written) as id,
      (select inserted from written) as inserted,
      ${piecesToBuySql(outfitId)} as "toBuy"`);
  const [row] = rows;
  refuseIncomplete(entry.outfitId, row.toBuy);
  if (row.inserted) return { outcome: 'scheduled', id: row.id! };
  return { outcome: 'already-scheduled', adopted: row.id !== null };
}

/**
 * The calendar's half of the incomplete rule (src/web/outfits/references.ts):
 * an entry never names an outfit holding a piece not bought yet. Each
 * writer that points an entry at an outfit (upsertEntry, planToWear,
 * setEntryOutfit) writes only where the outfit is complete and reads its
 * pieces to buy in the same statement; with any, it wrote nothing and this
 * refuses, rolling the caller's transaction back.
 */
function refuseIncomplete(outfitId: number, toBuy: readonly PieceToBuy[]) {
  if (toBuy.length > 0) throw new OutfitIncomplete(outfitId, toBuy);
}

/**
 * The owner's entry for `outfitId` on `day` (an outfit is on a day once, so
 * there is at most one), for a caller that planned it through insertEntry
 * and must act on the entry whether it was new or already there (the week
 * planner), or that must
 * not plan it twice (replaceEntryOutfit, which names the occasion it is
 * on). Served by the unique (owner_id, day, outfit_id) index.
 */
export async function entryOf(
  db: Queryable,
  ownerId: number,
  day: IsoDate,
  outfitId: number,
): Promise<{ id: number; occasion: Occasion } | undefined> {
  const [row] = await db
    .select({ id: outfitCalendar.id, occasion: outfitCalendar.occasion })
    .from(outfitCalendar)
    .where(
      and(
        eq(outfitCalendar.ownerId, ownerId),
        eq(outfitCalendar.day, day),
        eq(outfitCalendar.outfitId, outfitId),
      ),
    );
  return row;
}

/** An entry replaceEntryOutfit is about to change, locked. */
export interface EntryToReplace {
  id: number;
  occasion: Occasion;
  outfitId: number;
  worn: boolean;
  plannedBy: PlannedBy;
}

/**
 * Locks the owner's entry `entryId` if it is on `day` and, when given, for
 * `occasion` (FOR UPDATE: setEntryWorn and setEntrySelfie lock it too, so a
 * wear marked meanwhile is seen here). Undefined for another's entry, a
 * missing one, or one elsewhere: a `replace=` naming an entry of another
 * day or occasion is a link that does not say what it would change.
 */
export async function lockEntryToReplace(
  tx: Queryable,
  ownerId: number,
  target: { entryId: number; day: IsoDate; occasion?: Occasion },
): Promise<EntryToReplace | undefined> {
  const [row] = await tx
    .select({
      id: outfitCalendar.id,
      occasion: outfitCalendar.occasion,
      outfitId: outfitCalendar.outfitId,
      wornAt: outfitCalendar.wornAt,
      plannedBy: outfitCalendar.plannedBy,
    })
    .from(outfitCalendar)
    .where(
      and(
        eq(outfitCalendar.id, target.entryId),
        eq(outfitCalendar.ownerId, ownerId),
        eq(outfitCalendar.day, target.day),
        target.occasion === undefined
          ? undefined
          : eq(outfitCalendar.occasion, target.occasion),
      ),
    )
    .for('update');
  if (!row) return undefined;
  const { wornAt, ...entry } = row;
  return { ...entry, worn: wornAt !== null };
}

/**
 * Puts an outfit on an entry, keeping its day and occasion. Only
 * replaceEntryOutfit (src/web/calendar/replace.ts) calls it, under the
 * owner lock, having locked the entry, refused a worn one and checked the
 * outfit is not on the day already (the unique key). The choice is the
 * person's from now on (planned_by 'user'), so the week's re-plan and Undo
 * leave it alone (#16), also when the outfit is the one the entry had (the
 * person choosing what the planner chose takes it over). An incomplete
 * outfit is refused (OutfitIncomplete), the entry unchanged.
 */
export async function setEntryOutfit(
  tx: Queryable,
  entryId: number,
  outfitId: number,
): Promise<void> {
  const outfit = sql`${outfitId}::int`;
  const { rows } = await tx.execute<{ toBuy: PieceToBuy[] }>(sql`
    with written as (
      update ${outfitCalendar} set outfit_id = ${outfit}, planned_by = 'user'
      where ${outfitCalendar.id} = ${entryId} and ${outfitIsComplete(outfit)}
    )
    select ${piecesToBuySql(outfit)} as "toBuy"`);
  refuseIncomplete(outfitId, rows[0].toBuy);
}

/** What wearOutfitOn did: the entry, whether it was new, and its worn change. */
export interface WornOutfit {
  entryId: number;
  scheduled: ScheduleOutcome;
  worn: Exclude<EntryWornOutcome, 'not-found' | 'future'>;
}

/**
 * "Wearing this" for an outfit the caller found to be the owner's: planned
 * on `day` for `occasion` (insertEntry: the outfit already on the day keeps
 * its entry and its occasion) and that entry marked worn (setEntryWorn), in
 * one transaction, so the calendar stays the one history of which outfit
 * was worn when (plan section 1). Today's "Wear this" (wearIdea, after
 * pickIdea) and a trip's "Wearing this today" (#10, src/web/trips). Safe
 * to repeat: a second call finds the entry (a concurrent one waits on the
 * owner lock, then reads it) and changeEntryWorn finds it worn
 * (`changed` false). 'future' for a day after `today`, before anything is
 * written.
 *
 * Two statements under the owner lock (#166; production pays a round trip
 * per statement): planning the entry locks and reads it (planToWear), and
 * marking it is setEntryWorn's own change (changeEntryWorn), not run at all
 * when it is worn already.
 */
export function wearOutfitOn(
  db: Queryable,
  input: {
    ownerId: number;
    outfitId: number;
    day: IsoDate;
    occasion: Occasion;
    at: Date;
    today: IsoDate;
  },
): Promise<WornOutfit | 'future'> {
  const { ownerId, outfitId, day, occasion } = input;
  if (day > input.today) return Promise.resolve('future');
  return ownerTransaction(db, ownerId, 'wearOutfitOn', async (tx) => {
    const { inserted, ...entry } = await planToWear(tx, {
      ownerId,
      outfitId,
      day,
      occasion,
    });
    const worn = await changeEntryWorn(tx, entry, {
      ownerId,
      worn: true,
      at: input.at,
      today: input.today,
    });
    // Cannot happen: the day is not ahead of today.
    if (worn === 'future') {
      throw new Error(`Entry ${entry.id} on ${day} could not be marked worn`);
    }
    return {
      entryId: entry.id,
      scheduled: inserted ? 'scheduled' : 'already-scheduled',
      worn,
    };
  });
}

/**
 * insertEntry for an entry about to be marked worn (wearOutfitOn): the
 * same insert, and the outfit already on the day keeps its entry and its
 * occasion, but a conflict always takes the entry over (planned_by 'user',
 * as marking it worn does anyway), so the statement locks and returns the
 * entry, new or not. One round trip where insertEntry, entryOf and
 * setEntryWorn's lock were three. The caller holds the owner lock.
 */
async function planToWear(
  tx: Queryable,
  entry: NewEntry,
): Promise<LockedEntry & { inserted: boolean }> {
  const outfitId = sql`${entry.outfitId}::int`;
  // As in upsertEntry: xmax is 0 on a row this statement inserted, and an
  // incomplete outfit's insert returns no row (refused by its `toBuy`).
  const { rows } = await tx.execute<{
    entry: (Omit<LockedEntry, 'wornAt'> & { wornAt: string | null }) | null;
    inserted: boolean | null;
    toBuy: PieceToBuy[];
  }>(sql`
    with written as (
      insert into ${outfitCalendar} (owner_id, day, outfit_id, occasion, planned_by)
      select ${entry.ownerId}::int, ${entry.day}::date, ${outfitId},
        ${entry.occasion}::text, ${entry.plannedBy ?? DEFAULT_PLANNED_BY}::text
      where ${outfitIsComplete(outfitId)}
      on conflict (owner_id, day, outfit_id) do update set planned_by = 'user'
      returning json_build_object(
        'id', ${outfitCalendar.id},
        'day', ${outfitCalendar.day},
        'outfitId', ${outfitCalendar.outfitId},
        'wornAt', ${outfitCalendar.wornAt}
      ) as entry, (xmax = 0) as inserted
    )
    select (select entry from written) as entry,
      (select inserted from written) as inserted,
      ${piecesToBuySql(outfitId)} as "toBuy"`);
  const [row] = rows;
  refuseIncomplete(entry.outfitId, row.toBuy);
  const { wornAt, ...planned } = row.entry!;
  return {
    ...planned,
    wornAt: wornAt === null ? null : new Date(wornAt),
    inserted: row.inserted!,
  };
}

/** The day of the owner's entry; undefined when it is not theirs. */
export async function ownEntryDay(
  db: Db,
  id: number,
  ownerId: number,
): Promise<IsoDate | undefined> {
  const [row] = await db
    .select({ day: outfitCalendar.day })
    .from(outfitCalendar)
    .where(and(eq(outfitCalendar.id, id), eq(outfitCalendar.ownerId, ownerId)));
  return row?.day;
}

/**
 * Deletes the owner's entry, the user saying it was wrong: its wears go
 * with it (garment_wear's foreign key) and so does its selfie, row here
 * (deleteEntrySelfie) and bytes after commit: the answer is the photo
 * names for the caller to unlink (removeEntry, writes.ts). Deleting the
 * outfit is different: its entries' wears and selfies are kept
 * (deleteOutfit, src/web/outfits/queries.ts). Under the owner lock: a
 * re-plan must not swap in an outfit for the entry the person just took
 * off the day.
 *
 * Two statements inside the lock, no look-up first (#165): the selfie's
 * delete is scoped to the owner, so for another's or a missing entry it
 * finds nothing, and the entry's own delete (which locks its row) answers
 * whether there was one. The selfie goes first, while the entry still
 * points at it.
 */
export function deleteEntry(
  db: Queryable,
  id: number,
  ownerId: number,
): Promise<{ selfies: string[] } | EntryMiss> {
  return ownerTransaction(db, ownerId, 'deleteEntry', async (tx) => {
    const selfies = await deleteEntrySelfie(tx, id, ownerId);
    const deleted = await tx
      .delete(outfitCalendar)
      .where(
        and(eq(outfitCalendar.id, id), eq(outfitCalendar.ownerId, ownerId)),
      )
      .returning({ id: outfitCalendar.id });
    return deleted.length > 0 ? { selfies } : 'not-found';
  });
}
