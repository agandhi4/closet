import { and, between, eq, sql } from 'drizzle-orm';
import type { Db, Queryable } from '../../db/client';
import { outfit, outfitCalendar } from '../../db/schema';
import type { Occasion } from '../../wardrobe/occasions';
import type { PlannedBy } from '../../wardrobe/week';
import { imageUrl } from '../files/image-url';
import { deleteEntrySelfie, SELFIE_WITH } from '../selfies/queries';
import { type EntryWornOutcome, setEntryWorn } from '../wears/queries';
import type { IsoDate } from './calendar-date';
import type { CalendarEntry } from './calendar-view';

/**
 * The calendar's reads and writes. Every one is scoped to the signed-in
 * owner: outfits and calendar entries are private whatever wardrobe shares
 * exist. An entry that is not the caller's is a miss, the same as one that
 * does not exist: the route answers 404 either way, so entry ids reveal
 * nothing about other users (WardrobeAccess, src/web/sharing/access.ts).
 */

export type EntryMiss = 'not-found';

/**
 * The owner's entries from `first` to `last` (inclusive), by day then id;
 * the page puts a day's entries in occasion order (buildCalendarView).
 */
export async function findEntries(
  db: Db,
  ownerId: number,
  first: IsoDate,
  last: IsoDate,
): Promise<CalendarEntry[]> {
  // Served by outfit_calendar_owner_id_day_outfit_id_unique (owner_id, day).
  const rows = await db.query.outfitCalendar.findMany({
    columns: {
      id: true,
      day: true,
      occasion: true,
      wornAt: true,
      plannedBy: true,
    },
    where: and(
      eq(outfitCalendar.ownerId, ownerId),
      between(outfitCalendar.day, first, last),
    ),
    orderBy: (entry, { asc }) => [asc(entry.day), asc(entry.id)],
    with: {
      selfie: SELFIE_WITH,
      outfit: {
        columns: { id: true, name: true },
        with: {
          // The outfit's garments in the order it was built (empty slots
          // have nothing to show).
          slots: {
            columns: {},
            where: (slot, { isNotNull }) => isNotNull(slot.garmentId),
            orderBy: (slot, { asc }) => [asc(slot.position)],
            with: {
              garment: {
                columns: {},
                with: { photo: { columns: { fileName: true, version: true } } },
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
    selfie: row.selfie,
    plannedBy: row.plannedBy,
    outfit: {
      id: row.outfit.id,
      name: row.outfit.name,
      photoUrls: row.outfit.slots.flatMap(({ garment }) =>
        garment?.photo ? [imageUrl(garment.photo, 'thumb')] : [],
      ),
    },
  }));
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
 */
export async function scheduleOutfit(
  db: Db,
  entry: NewEntry,
): Promise<Scheduled | 'no-such-outfit'> {
  if (!(await ownsOutfit(db, entry.ownerId, entry.outfitId))) {
    return 'no-such-outfit';
  }
  return insertEntry(db, entry);
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
 * starts unworn: setEntryWorn (src/web/wears/queries.ts) is the only way to
 * mark one, because its wear rows change with it.
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
 */
export async function insertEntry(
  db: Queryable,
  entry: NewEntry,
): Promise<Scheduled> {
  const [row] = await db
    .insert(outfitCalendar)
    .values(entry)
    .onConflictDoUpdate({
      target: [
        outfitCalendar.ownerId,
        outfitCalendar.day,
        outfitCalendar.outfitId,
      ],
      set: { plannedBy: 'user' },
      setWhere: sql`${outfitCalendar.plannedBy} = 'auto' and excluded.planned_by = 'user'`,
    })
    // xmax is 0 on a row this statement inserted and set on one it updated:
    // Postgres' way of telling the two apart in one ON CONFLICT statement.
    // A conflict the WHERE refuses returns no row at all.
    .returning({
      id: outfitCalendar.id,
      inserted: sql<boolean>`(xmax = 0)`,
    });
  if (row?.inserted) return { outcome: 'scheduled', id: row.id };
  return { outcome: 'already-scheduled', adopted: row !== undefined };
}

/**
 * The owner's entry for `outfitId` on `day` (an outfit is on a day once, so
 * there is at most one), for a caller that planned it through insertEntry
 * and must act on the entry whether it was new or already there
 * (wearOutfitOn; the week planner), or that must
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
 * Puts another outfit on an entry, keeping its day and occasion. Only
 * replaceEntryOutfit (src/web/calendar/replace.ts) calls it, having locked
 * the entry, refused a worn one and checked the outfit is not on the day
 * already (the unique key). The choice is the person's from now on
 * (planned_by 'user'), so the week's re-plan and Undo leave it alone (#16).
 */
export async function setEntryOutfit(
  tx: Queryable,
  entryId: number,
  outfitId: number,
): Promise<void> {
  await tx
    .update(outfitCalendar)
    .set({ outfitId, plannedBy: 'user' })
    .where(eq(outfitCalendar.id, entryId));
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
 * unique key, then reads it) and setEntryWorn finds it worn (`changed`
 * false). 'future' for a day after `today`, before anything is written.
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
  return db.transaction(async (tx) => {
    const scheduled = await insertEntry(tx, {
      ownerId,
      outfitId,
      day,
      occasion,
    });
    // Planned just now or already on the day: either way there is one.
    const entryId =
      scheduled.outcome === 'scheduled'
        ? scheduled.id
        : (await entryOf(tx, ownerId, day, outfitId))!.id;
    const worn = await setEntryWorn(tx, {
      entryId,
      ownerId,
      worn: true,
      at: input.at,
      today: input.today,
    });
    // Neither can happen: the entry was just found, and its day is not ahead.
    if (worn === 'not-found' || worn === 'future') {
      throw new Error(`Entry ${entryId} on ${day} could not be marked worn`);
    }
    return { entryId, scheduled: scheduled.outcome, worn };
  });
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
 * (deleteOutfit, src/web/outfits/queries.ts).
 */
export function deleteEntry(
  db: Db,
  id: number,
  ownerId: number,
): Promise<{ selfies: string[] } | EntryMiss> {
  return db.transaction(async (tx) => {
    const [entry] = await tx
      .select({ id: outfitCalendar.id })
      .from(outfitCalendar)
      .where(
        and(eq(outfitCalendar.id, id), eq(outfitCalendar.ownerId, ownerId)),
      )
      .for('update');
    if (!entry) return 'not-found';
    const selfies = await deleteEntrySelfie(tx, id);
    await tx.delete(outfitCalendar).where(eq(outfitCalendar.id, id));
    return { selfies };
  });
}
