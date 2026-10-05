import { and, asc, desc, eq, isNotNull, type SQL, sql } from 'drizzle-orm';
import type { Db, Queryable } from '../../db/client';
import {
  outfit,
  outfitCalendar,
  trip,
  tripItem,
  tripOutfit,
} from '../../db/schema';
import type { Occasion } from '../../wardrobe/occasions';
import type { Location } from '../../weather/location';
import { addDays, type IsoDate } from '../calendar/calendar-date';
import { pickIdea, type PickResult } from '../gallery/ideas';
import { refuseUnholdable } from '../outfits/gone-garments';
import {
  holdRefusalColumns,
  outfitMayBeHeld,
  type PieceToBuy,
} from '../outfits/references';
import { intArray, lockedTripCte, lockTrip, prunePacked } from './packed';

/**
 * Trips' reads and writes (#10; docs/plans/2026-09-26-wardrobe-features.md,
 * section 4). The owner's own, like outfits: every function is scoped to
 * the signed-in owner, and another user's trip is a miss like a missing
 * one (the routes answer 404 either way). One writer per piece of state:
 * the trip (createTrip, updateTrip, setTripDestination, deleteTrip), its
 * outfits (addTripOutfit, pickForTrip, removeTripOutfit), its extras
 * (addTripItems, copyTripItems, setItemsPacked, removeTripItem); the
 * garments' packed marks are packed.ts's. Every write to a trip takes the
 * trip's row lock first (lockTrip), so they take turns.
 */

/** What the trip form writes: trimmed, a blank destination and notes null. */
export interface TripFields {
  name: string;
  destination: string | null;
  startsOn: IsoDate;
  endsOn: IsoDate;
  notes: string | null;
}

export interface TripRow extends TripFields {
  id: number;
  /** The destination picked from the geocoding search, rounded; null until then. */
  location: Location | null;
}

const tripColumns = {
  id: trip.id,
  name: trip.name,
  destination: trip.destination,
  latitude: trip.latitude,
  longitude: trip.longitude,
  startsOn: trip.startsOn,
  endsOn: trip.endsOn,
  notes: trip.notes,
};

/** A trip as it is read: its columns, or ownTripSql's JSON (the same shape). */
export type TripSelect = {
  latitude: number | null;
  longitude: number | null;
} & Omit<TripRow, 'location'>;

export function tripRow({
  latitude,
  longitude,
  ...fields
}: TripSelect): TripRow {
  // trip_location_check keeps the two together.
  return {
    ...fields,
    location:
      latitude !== null && longitude !== null ? { latitude, longitude } : null,
  };
}

/** The trip's days, first to last. */
export function tripDays(trip: {
  startsOn: IsoDate;
  endsOn: IsoDate;
}): IsoDate[] {
  const days: IsoDate[] = [];
  for (let day = trip.startsOn; day <= trip.endsOn; day = addDays(day, 1)) {
    days.push(day);
  }
  return days;
}

/**
 * The day a trip's ideas are for (the gallery, suggest-style tools): the
 * day asked when it is one of the trip's, else today while the trip is on,
 * else its first day.
 */
export function ideasDayOf(
  trip: { startsOn: IsoDate; endsOn: IsoDate },
  asked: IsoDate | undefined,
  today: IsoDate,
): IsoDate {
  if (asked && asked >= trip.startsOn && asked <= trip.endsOn) return asked;
  return today >= trip.startsOn && today <= trip.endsOn ? today : trip.startsOn;
}

/** The owner's trip, or undefined. */
export async function findTrip(
  db: Queryable,
  id: number,
  ownerId: number,
): Promise<TripRow | undefined> {
  const [row] = await db
    .select(tripColumns)
    .from(trip)
    .where(ownsTripWhere(id, ownerId));
  return row && tripRow(row);
}

/**
 * findTrip as a scalar subquery (null when the trip is not the owner's),
 * so a page reads the trip in one statement with what it shows beside it
 * (selectScalars: tripModel, the add page, the forecast fragment). JSON
 * gives the dates as ISO strings and the numerics as numbers: TripSelect.
 */
export function ownTripSql(
  id: number,
  ownerId: number,
): SQL<TripSelect | null> {
  return sql<TripSelect | null>`(
    select json_build_object(
      'id', ${trip.id},
      'name', ${trip.name},
      'destination', ${trip.destination},
      'latitude', ${trip.latitude},
      'longitude', ${trip.longitude},
      'startsOn', ${trip.startsOn},
      'endsOn', ${trip.endsOn},
      'notes', ${trip.notes}
    )
    from ${trip}
    where ${ownsTripWhere(id, ownerId)}
  )`;
}

function ownsTripWhere(id: number, ownerId: number): SQL {
  return and(eq(trip.id, id), eq(trip.ownerId, ownerId))!;
}

/**
 * Whether the trip is the owner's, as a condition uncorrelated with the
 * enclosing query: the reads of a trip's rows (its extras, its outfits'
 * days) carry it, so another user's trip reads nothing.
 */
function ownsTrip(id: number, ownerId: number): SQL {
  return sql`exists (select 1 from ${trip} where ${ownsTripWhere(id, ownerId)})`;
}

export interface TripSummary extends TripRow {
  outfits: number;
  extras: number;
}

// The trip row of the outer query, written out: in a single-table select
// Drizzle renders a column without its table (CLAUDE.md Gotchas), so
// `${trip.id}` inside these subqueries would read the subquery's own id.
const OUTER_TRIP_ID = sql.raw('"trip"."id"');

/**
 * The owner's trips with their outfit and extras counts: those not over by
 * `today` first, soonest first, then the past ones, latest first. One
 * statement (trip_owner_id_starts_on_index).
 */
export async function listTrips(
  db: Db,
  ownerId: number,
  today: IsoDate,
): Promise<TripSummary[]> {
  const rows = await db
    .select({
      ...tripColumns,
      outfits: sql<number>`(select count(*)::int from ${tripOutfit} o where o.trip_id = ${OUTER_TRIP_ID})`,
      extras: sql<number>`(select count(*)::int from ${tripItem} i where i.trip_id = ${OUTER_TRIP_ID})`,
    })
    .from(trip)
    .where(eq(trip.ownerId, ownerId))
    .orderBy(
      sql`${trip.endsOn} < ${today}`,
      sql`case when ${trip.endsOn} < ${today} then null else ${trip.startsOn} end`,
      desc(trip.startsOn),
      asc(trip.id),
    );
  return rows.map(({ outfits, extras, ...row }) => ({
    ...tripRow(row),
    outfits,
    extras,
  }));
}

export async function createTrip(
  db: Queryable,
  ownerId: number,
  fields: TripFields,
): Promise<number> {
  const [row] = await db
    .insert(trip)
    .values({ ownerId, ...fields })
    .returning({ id: trip.id });
  return row.id;
}

/**
 * The trip form's save. A new destination name clears the location, which
 * described the old one (the trip page offers the search again). The trip's
 * outfits on days the new dates leave out lose their day and stay on the
 * trip ("Any day"), so trip_outfit.day is always one of the trip's days;
 * one that would then be the outfit's second undated row goes, since the
 * outfit is on the trip already. 'not-found' when the trip is not the
 * owner's.
 *
 * Two statements in its transaction (#166): the trip locked and its
 * destination read, then every write in one. The writes judge the trip's
 * outfits, so they read them after the lock, never in its statement
 * (lockedTripCte). They touch disjoint rows: an outfit's rows leaving the
 * dates are all deleted but its first, which loses its day unless the
 * outfit has an undated row already (then that one goes too); so no row
 * is both deleted and undated, and no two undated rows collide.
 */
export function updateTrip(
  db: Db,
  id: number,
  ownerId: number,
  fields: TripFields,
): Promise<{ undated: number; locationCleared: boolean } | 'not-found'> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ destination: trip.destination })
      .from(trip)
      .where(ownsTripWhere(id, ownerId))
      .for('update');
    if (!current) return 'not-found';
    const locationCleared = current.destination !== fields.destination;
    const { startsOn, endsOn } = fields;
    const outside = (row: string) =>
      sql`(${sql.raw(row)}.day < ${startsOn} or ${sql.raw(row)}.day > ${endsOn})`;
    // Another row of the outfit keeps it on the trip: an undated one, or
    // an earlier one leaving the dates too.
    const kept = sql`exists (
      select 1 from ${tripOutfit} u
      where u.trip_id = o.trip_id and u.outfit_id = o.outfit_id and u.id <> o.id
      and (u.day is null or (${outside('u')} and u.id < o.id))
    )`;
    const leaving = sql`o.trip_id = ${id} and o.day is not null and ${outside('o')}`;
    const { rows } = await tx.execute<{ undated: number }>(sql`
      with saved as (
        update ${trip} set
          name = ${fields.name},
          destination = ${fields.destination},
          starts_on = ${startsOn},
          ends_on = ${endsOn},
          notes = ${fields.notes}
          ${locationCleared ? sql`, latitude = null, longitude = null` : sql.empty()}
        where ${eq(trip.id, id)}
      ),
      removed as (
        delete from ${tripOutfit} o where ${leaving} and ${kept}
      ),
      undated as (
        update ${tripOutfit} o set day = null
        where ${leaving} and not ${kept}
        returning 1
      )
      select count(*)::int as undated from undated`);
    return { undated: rows[0].undated, locationCleared };
  });
}

/**
 * The destination picked from the geocoding search: its name and rounded
 * location together. False when the trip is not the owner's.
 */
export async function setTripDestination(
  db: Queryable,
  id: number,
  ownerId: number,
  place: { name: string; location: Location },
): Promise<boolean> {
  const updated = await db
    .update(trip)
    .set({
      destination: place.name,
      latitude: place.location.latitude,
      longitude: place.location.longitude,
    })
    .where(ownsTripWhere(id, ownerId))
    .returning({ id: trip.id });
  return updated.length > 0;
}

/** Deletes the owner's trip; its outfits' links, extras and marks cascade (the outfits stay). */
export async function deleteTrip(
  db: Db,
  id: number,
  ownerId: number,
): Promise<boolean> {
  const deleted = await db
    .delete(trip)
    .where(ownsTripWhere(id, ownerId))
    .returning({ id: trip.id });
  return deleted.length > 0;
}

/** Where an outfit goes on a trip: one of its days, an occasion, both optional. */
export interface TripSlot {
  day?: IsoDate;
  occasion?: Occasion;
}

export type TripOutfitAdded = 'added' | 'already';

type TripRefusal = 'no-trip' | 'not-a-trip-day';

/**
 * Inserts the trip outfit once (the partial unique indexes: the same outfit
 * on the same day, or without a day, is there already). The caller holds
 * the trip's lock and has checked the outfit is the owner's and the day the
 * trip's. Only pickForTrip's: its outfit is a pick of closet garments, so
 * complete (src/web/outfits/references.ts); a saved outfit goes through
 * addTripOutfit, which judges that.
 */
async function insertTripOutfit(
  tx: Queryable,
  tripId: number,
  outfitId: number,
  slot: TripSlot,
): Promise<TripOutfitAdded> {
  const inserted = await tx
    .insert(tripOutfit)
    .values({
      tripId,
      outfitId,
      day: slot.day ?? null,
      occasion: slot.occasion ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: tripOutfit.id });
  return inserted.length > 0 ? 'added' : 'already';
}

/**
 * Whether a trip outfit may be for `day`: any day (none given) or one of
 * the trip's. addTripOutfit's statement asks the same in SQL.
 */
function isTripDay(
  trip: { startsOn: IsoDate; endsOn: IsoDate },
  day: IsoDate | undefined,
): boolean {
  return day === undefined || (day >= trip.startsOn && day <= trip.endsOn);
}

/** The trip locked, and `day` one of its days (when given). */
async function lockTripFor(
  tx: Queryable,
  tripId: number,
  ownerId: number,
  day: IsoDate | undefined,
): Promise<TripRefusal | undefined> {
  const locked = await lockTrip(tx, tripId, ownerId);
  if (!locked) return 'no-trip';
  return isTripDay(locked, day) ? undefined : 'not-a-trip-day';
}

/**
 * Adds the owner's saved outfit to their trip, for a day and occasion when
 * given (the add page, plan_trip_outfit). Idempotent: the same outfit on the
 * same day (or without one) again adds nothing and keeps the occasion it
 * has ('already'), the calendar's rule. The refusal is told in the order
 * the checks were made one by one: the trip, the day, the outfit; and an
 * outfit that may not be held (#335, outfitMayBeHeld: a piece not bought
 * yet, or Muse's proposal not the owner's yet) is refused
 * (refuseUnholdable), nothing added.
 *
 * Two statements in a transaction (lockedTripCte): the first locks the
 * trip, then the owner's outfit FOR KEY SHARE (what the insert's foreign
 * key takes anyway), and reads both; the second inserts only where the
 * outfit may be held (outfitMayBeHeld). **The completeness check must not share the lock's
 * statement:** an edit adding a piece holds the outfit FOR UPDATE
 * (updateOutfit), and a statement that waited for it still judges the
 * slots by the snapshot it took before the wait, so it would pack the
 * outfit the edit just made incomplete. The second statement's snapshot
 * is taken after the lock, so it sees the edit; an edit after it waits for
 * this commit and then finds the outfit held (slotMayNameSql).
 *
 * The outfit is read from outside the trip, so the first statement's
 * snapshot may still hold one deleted meanwhile: a row locked after a wait
 * is read again, so a deleted outfit drops out and the answer is
 * 'no-outfit', never the foreign key's 500. `exists (select 1 from
 * locked)` is a one-time filter that takes the trip lock before the
 * outfit's, the order every trip write keeps (deleteOutfit locks the
 * outfit and never a trip, so they cannot deadlock).
 */
export function addTripOutfit(
  db: Queryable,
  input: { tripId: number; ownerId: number; outfitId: number } & TripSlot,
): Promise<TripOutfitAdded | TripRefusal | 'no-outfit'> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.execute<{
      startsOn: IsoDate;
      endsOn: IsoDate;
      owned: boolean;
    }>(sql`
      with ${lockedTripCte(input.tripId, input.ownerId)},
      owned as (
        select ${outfit.id} as id from ${outfit}
        where ${and(eq(outfit.id, input.outfitId), eq(outfit.ownerId, input.ownerId))}
        and exists (select 1 from locked)
        for key share
      )
      select to_char(locked.starts_on, 'YYYY-MM-DD') as "startsOn",
        to_char(locked.ends_on, 'YYYY-MM-DD') as "endsOn",
        exists (select 1 from owned) as owned
      from locked`);
    const [found] = rows;
    if (!found) return 'no-trip';
    if (!isTripDay(found, input.day)) return 'not-a-trip-day';
    if (!found.owned) return 'no-outfit';
    const outfitId = sql`${input.outfitId}::int`;
    const {
      rows: [written],
    } = await tx.execute<{
      added: boolean;
      toBuy: PieceToBuy[];
      pending: boolean;
    }>(sql`
      with added as (
        insert into ${tripOutfit} (trip_id, outfit_id, day, occasion)
        select ${input.tripId}::int, ${outfitId}, ${input.day ?? null}::date,
          ${input.occasion ?? null}::text
        where ${outfitMayBeHeld(outfitId)}
        on conflict do nothing
        returning 1
      )
      select exists (select 1 from added) as added,
        ${holdRefusalColumns(outfitId)}`);
    refuseUnholdable(input.outfitId, written);
    return written.added ? 'added' : 'already';
  });
}

/**
 * The gallery's pick for a trip (`?for=trip:ID[:day]`) and plan_trip_outfit
 * with garments: the idea becomes an outfit, once (pickIdea: reused when the
 * owner has one of exactly these garments), and goes on the trip, in one
 * transaction under the trip's lock (taken before pickIdea's owner lock,
 * the order every trip write keeps). 'not-found' when a garment is not in
 * the owner's closet; nothing is written on any refusal.
 */
export function pickForTrip(
  db: Queryable,
  ownerId: number,
  input: {
    tripId: number;
    garmentIds: readonly number[];
    name?: string;
  } & TripSlot,
): Promise<
  { outfit: PickResult; added: TripOutfitAdded } | TripRefusal | 'not-found'
> {
  return db.transaction(async (tx) => {
    const refused = await lockTripFor(tx, input.tripId, ownerId, input.day);
    if (refused) return refused;
    const picked = await pickIdea(tx, ownerId, {
      garmentIds: input.garmentIds,
      name: input.name,
    });
    if (picked === 'not-found') return 'not-found';
    const added = await insertTripOutfit(tx, input.tripId, picked.id, input);
    return { outfit: picked, added };
  });
}

/**
 * Takes an outfit off the owner's trip (the outfit itself stays), and with
 * it the packed marks of garments no other outfit of the trip holds. Two
 * statements in its transaction (#166): the trip locked and the row
 * deleted (by its id, which a stale read cannot mistake), then the prune,
 * which judges the trip's outfits and so reads them after the lock
 * (lockedTripCte).
 */
export function removeTripOutfit(
  db: Db,
  input: { tripId: number; tripOutfitId: number; ownerId: number },
): Promise<{ outfitId: number; unpacked: number } | 'not-found'> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ outfitId: number }>(sql`
      with ${lockedTripCte(input.tripId, input.ownerId)}
      delete from ${tripOutfit}
      where ${and(
        eq(tripOutfit.id, input.tripOutfitId),
        eq(tripOutfit.tripId, input.tripId),
      )}
      and exists (select 1 from locked)
      returning ${tripOutfit.outfitId} as "outfitId"`);
    const [removed] = rows;
    if (!removed) return 'not-found';
    const unpacked = await prunePacked(tx, [input.tripId]);
    return { outfitId: removed.outfitId, unpacked };
  });
}

/** A trip outfit, as "Wearing this today" needs it: which outfit, and for which occasion. */
export async function findTripOutfit(
  db: Queryable,
  input: { tripId: number; tripOutfitId: number; ownerId: number },
): Promise<
  | {
      outfitId: number;
      day: IsoDate | null;
      occasion: Occasion | null;
      trip: { startsOn: IsoDate; endsOn: IsoDate };
    }
  | undefined
> {
  const [row] = await db
    .select({
      outfitId: tripOutfit.outfitId,
      day: tripOutfit.day,
      occasion: tripOutfit.occasion,
      startsOn: trip.startsOn,
      endsOn: trip.endsOn,
    })
    .from(tripOutfit)
    .innerJoin(trip, eq(trip.id, tripOutfit.tripId))
    .where(
      and(
        eq(tripOutfit.id, input.tripOutfitId),
        eq(tripOutfit.tripId, input.tripId),
        eq(trip.ownerId, input.ownerId),
      ),
    );
  return (
    row && {
      outfitId: row.outfitId,
      day: row.day,
      occasion: row.occasion,
      trip: { startsOn: row.startsOn, endsOn: row.endsOn },
    }
  );
}

/** A trip outfit's outfit and day (null: any day). */
export interface TripOutfitDay {
  outfitId: number;
  day: IsoDate | null;
}

/**
 * The owner's trip's outfits and their days, as a scalar subquery: the add
 * page reads it with the trip and offers those on the chosen day disabled
 * (outfitsOnDay). Every row, since which day is chosen depends on the
 * trip's dates: a trip holds a handful.
 */
export function tripOutfitDaysSql(
  tripId: number,
  ownerId: number,
): SQL<TripOutfitDay[]> {
  return sql<TripOutfitDay[]>`(
    select coalesce(
      json_agg(json_build_object('outfitId', ${tripOutfit.outfitId}, 'day', ${tripOutfit.day})),
      '[]'
    )
    from ${tripOutfit}
    where ${tripOutfit.tripId} = ${tripId} and ${ownsTrip(tripId, ownerId)}
  )`;
}

/** The outfits on the trip for `day` (null: without a day). */
export function outfitsOnDay(
  outfits: readonly TripOutfitDay[],
  day: IsoDate | null,
): Set<number> {
  return new Set(outfits.flatMap((o) => (o.day === day ? [o.outfitId] : [])));
}

/**
 * The outfits of the owner's marked worn on `day`, as a scalar subquery:
 * the trip page's "Worn today" (outfit_calendar_owner_id_day_outfit_id_unique).
 */
export function outfitsWornOnSql(ownerId: number, day: IsoDate): SQL<number[]> {
  return sql<number[]>`(
    select coalesce(json_agg(${outfitCalendar.outfitId}), '[]')
    from ${outfitCalendar}
    where ${and(
      eq(outfitCalendar.ownerId, ownerId),
      eq(outfitCalendar.day, day),
      isNotNull(outfitCalendar.wornAt),
    )}
  )`;
}

// ---- Extras -------------------------------------------------------------------

export interface TripItemRow {
  id: number;
  label: string;
  packed: boolean;
}

/** The trip's extras in the order added. */
export function tripItems(
  db: Queryable,
  tripId: number,
): Promise<TripItemRow[]> {
  return db
    .select({ id: tripItem.id, label: tripItem.label, packed: tripItem.packed })
    .from(tripItem)
    .where(eq(tripItem.tripId, tripId))
    .orderBy(asc(tripItem.id));
}

/**
 * The owner's trip's extras in the order added, as a scalar subquery: the
 * trip page reads them with the rest of the trip (tripModel).
 */
export function tripItemsSql(
  tripId: number,
  ownerId: number,
): SQL<TripItemRow[]> {
  return sql<TripItemRow[]>`(
    select coalesce(
      json_agg(
        json_build_object('id', ${tripItem.id}, 'label', ${tripItem.label}, 'packed', ${tripItem.packed})
        order by ${tripItem.id}
      ),
      '[]'
    )
    from ${tripItem}
    where ${tripItem.tripId} = ${tripId} and ${ownsTrip(tripId, ownerId)}
  )`;
}

/**
 * Inserts `labels` (in their order, so their ids ascend in it) on the
 * locked trip of the statement's `locked` CTE (lockedTripCte), unpacked; a
 * label the trip has, in any case, is skipped by the unique index. The
 * CTE `added`, a row per extra added.
 */
function addedItemsCte(labels: SQL): SQL {
  return sql`added as (
    insert into ${tripItem} (trip_id, label)
    select locked.id, given.label from locked, ${labels} as given(label, n)
    order by given.n
    on conflict do nothing
    returning 1
  )`;
}

/**
 * Adds extras (labels trimmed, never blank) unpacked; a label already on the
 * trip, in any case, adds nothing. The count added; 'not-found' when the
 * trip is not the owner's. One statement (lockedTripCte).
 */
export async function addTripItems(
  db: Queryable,
  tripId: number,
  ownerId: number,
  labels: readonly string[],
): Promise<number | 'not-found'> {
  const given = labels
    .map((label) => label.trim())
    .filter((label) => label.length > 0);
  const list = sql`unnest(array[${sql.join(
    given.map((label) => sql`${label}`),
    sql`, `,
  )}]::text[]) with ordinality`;
  const { rows } = await db.execute<{ found: boolean; added: number }>(sql`
    with ${lockedTripCte(tripId, ownerId)}, ${addedItemsCte(list)}
    select exists (select 1 from locked) as found,
      (select count(*)::int from added) as added`);
  const [{ found, added }] = rows;
  return found ? added : 'not-found';
}

/**
 * "Copy extras from a previous trip": the other trip's labels, unpacked, in
 * its order, those this trip has already skipped (so copying twice adds
 * nothing). Both trips must be the owner's, and not the same one; the count
 * added. One statement: the other trip's extras are read where they are
 * copied (lockedTripCte locks only this one, as the copy writes only here).
 */
export async function copyTripItems(
  db: Queryable,
  input: { fromTripId: number; toTripId: number; ownerId: number },
): Promise<number | 'not-found'> {
  const { fromTripId, toTripId, ownerId } = input;
  const from = sql`(
    select ${tripItem.label}, ${tripItem.id}
    from ${tripItem}
    where ${tripItem.tripId} = ${fromTripId} and ${ownsTrip(fromTripId, ownerId)}
    and ${fromTripId}::int <> ${toTripId}::int
  )`;
  const { rows } = await db.execute<{ found: boolean; added: number }>(sql`
    with ${lockedTripCte(toTripId, ownerId)}, ${addedItemsCte(from)}
    select exists (select 1 from locked)
        and ${ownsTrip(fromTripId, ownerId)}
        and ${fromTripId}::int <> ${toTripId}::int as found,
      (select count(*)::int from added) as added`);
  const [{ found, added }] = rows;
  return found ? added : 'not-found';
}

/**
 * The extras' autosave: checked ones packed, shown and unchecked ones not
 * (an id in both ends unpacked); ids of another trip's extras are ignored.
 * Answers the counts changed and the trip's extras as they now are (the
 * summary the autosave answers), in one statement (lockedTripCte): the
 * extras read from before the change, with the changed rows' new values.
 * 'not-found' when the trip is not the owner's.
 */
export async function setItemsPacked(
  db: Queryable,
  input: {
    tripId: number;
    ownerId: number;
    packed: readonly number[];
    unpacked: readonly number[];
  },
): Promise<
  { packed: number; unpacked: number; items: TripItemRow[] } | 'not-found'
> {
  const { tripId } = input;
  const unpacked = intArray(input.unpacked);
  const shown = intArray([...input.packed, ...input.unpacked]);
  const { rows } = await db.execute<{
    found: boolean;
    packed: number;
    unpacked: number;
    items: TripItemRow[];
  }>(sql`
    with ${lockedTripCte(tripId, input.ownerId)},
    changed as (
      update ${tripItem} set packed = not (${tripItem.id} = any(${unpacked}))
      where ${tripItem.tripId} = ${tripId} and exists (select 1 from locked)
      and ${tripItem.id} = any(${shown})
      -- only the rows it changes
      and ${tripItem.packed} = (${tripItem.id} = any(${unpacked}))
      returning ${tripItem.id} as id, ${tripItem.packed} as packed
    )
    select exists (select 1 from locked) as found,
      (select count(*)::int from changed where packed) as packed,
      (select count(*)::int from changed where not packed) as unpacked,
      (
        select coalesce(
          json_agg(
            json_build_object('id', i.id, 'label', i.label, 'packed', coalesce(changed.packed, i.packed))
            order by i.id
          ),
          '[]'
        )
        from ${tripItem} i left join changed on changed.id = i.id
        where i.trip_id = ${tripId} and exists (select 1 from locked)
      ) as items`);
  const [{ found, ...change }] = rows;
  return found ? change : 'not-found';
}

/** Removes one extra of the owner's trip; false when it is not theirs. */
export async function removeTripItem(
  db: Db,
  input: { tripId: number; itemId: number; ownerId: number },
): Promise<boolean> {
  const removed = await db
    .delete(tripItem)
    .where(
      and(
        eq(tripItem.id, input.itemId),
        eq(tripItem.tripId, input.tripId),
        sql`exists (select 1 from ${trip} where ${trip.id} = ${tripItem.tripId} and ${trip.ownerId} = ${input.ownerId})`,
      ),
    )
    .returning({ id: tripItem.id });
  return removed.length > 0;
}

/** Another trip to copy extras from: its name and how many it has. */
export interface TripCopySource {
  id: number;
  name: string;
  extras: number;
}

/**
 * The owner's other trips that have extras, latest first: "Copy extras
 * from", as a scalar subquery the trip page reads with the trip.
 */
export function tripsWithItemsSql(
  ownerId: number,
  exceptTripId: number,
): SQL<TripCopySource[]> {
  const others = sql`(
    select ${trip.id}, ${trip.name}, ${trip.startsOn}, count(${tripItem.id})::int as extras
    from ${trip}
    inner join ${tripItem} on ${eq(tripItem.tripId, trip.id)}
    where ${and(eq(trip.ownerId, ownerId), sql`${trip.id} <> ${exceptTripId}`)}
    group by ${trip.id}
  )`;
  return sql<TripCopySource[]>`(
    select coalesce(
      json_agg(
        json_build_object('id', other.id, 'name', other.name, 'extras', other.extras)
        order by other.starts_on desc, other.id desc
      ),
      '[]'
    )
    from ${others} other
  )`;
}
