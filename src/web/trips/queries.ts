import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  sql,
} from 'drizzle-orm';
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
import { lockTrip, prunePacked } from './packed';

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

type TripSelect = {
  latitude: number | null;
  longitude: number | null;
} & Omit<TripRow, 'location'>;

function tripRow({ latitude, longitude, ...fields }: TripSelect): TripRow {
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
    .where(and(eq(trip.id, id), eq(trip.ownerId, ownerId)));
  return row && tripRow(row);
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
      .where(and(eq(trip.id, id), eq(trip.ownerId, ownerId)))
      .for('update');
    if (!current) return 'not-found';
    const locationCleared = current.destination !== fields.destination;
    await tx
      .update(trip)
      .set({
        ...fields,
        ...(locationCleared && { latitude: null, longitude: null }),
      })
      .where(eq(trip.id, id));
    const outside = sql`(${tripOutfit.day} < ${fields.startsOn} or ${tripOutfit.day} > ${fields.endsOn})`;
    // An outfit's rows about to lose their day: all but one would collide
    // with each other, or with a row it has without a day already.
    await tx.execute(sql`
      delete from ${tripOutfit} o
      where o.trip_id = ${id} and o.day is not null
      and (o.day < ${fields.startsOn} or o.day > ${fields.endsOn})
      and exists (
        select 1 from ${tripOutfit} u
        where u.trip_id = o.trip_id and u.outfit_id = o.outfit_id and u.id <> o.id
        and (u.day is null or ((u.day < ${fields.startsOn} or u.day > ${fields.endsOn}) and u.id < o.id))
      )`);
    const undated = await tx
      .update(tripOutfit)
      .set({ day: null })
      .where(and(eq(tripOutfit.tripId, id), isNotNull(tripOutfit.day), outside))
      .returning({ id: tripOutfit.id });
    return { undated: undated.length, locationCleared };
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
    .where(and(eq(trip.id, id), eq(trip.ownerId, ownerId)))
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
    .where(and(eq(trip.id, id), eq(trip.ownerId, ownerId)))
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
 * trip's.
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

/** The trip locked, and `day` one of its days (when given). */
async function lockTripFor(
  tx: Queryable,
  tripId: number,
  ownerId: number,
  day: IsoDate | undefined,
): Promise<TripRefusal | undefined> {
  const locked = await lockTrip(tx, tripId, ownerId);
  if (!locked) return 'no-trip';
  if (day !== undefined && (day < locked.startsOn || day > locked.endsOn)) {
    return 'not-a-trip-day';
  }
  return undefined;
}

/**
 * Adds the owner's saved outfit to their trip, for a day and occasion when
 * given (the add page, plan_trip_outfit). Idempotent: the same outfit on the
 * same day (or without one) again adds nothing and keeps the occasion it
 * has ('already'), the calendar's rule.
 */
export function addTripOutfit(
  db: Queryable,
  input: { tripId: number; ownerId: number; outfitId: number } & TripSlot,
): Promise<TripOutfitAdded | TripRefusal | 'no-outfit'> {
  return db.transaction(async (tx) => {
    const refused = await lockTripFor(
      tx,
      input.tripId,
      input.ownerId,
      input.day,
    );
    if (refused) return refused;
    const [owned] = await tx
      .select({ id: outfit.id })
      .from(outfit)
      .where(
        and(eq(outfit.id, input.outfitId), eq(outfit.ownerId, input.ownerId)),
      );
    if (!owned) return 'no-outfit';
    return insertTripOutfit(tx, input.tripId, input.outfitId, input);
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
 * it the packed marks of garments no other outfit of the trip holds.
 */
export function removeTripOutfit(
  db: Db,
  input: { tripId: number; tripOutfitId: number; ownerId: number },
): Promise<{ outfitId: number; unpacked: number } | 'not-found'> {
  return db.transaction(async (tx) => {
    if (!(await lockTrip(tx, input.tripId, input.ownerId))) return 'not-found';
    const [removed] = await tx
      .delete(tripOutfit)
      .where(
        and(
          eq(tripOutfit.id, input.tripOutfitId),
          eq(tripOutfit.tripId, input.tripId),
        ),
      )
      .returning({ outfitId: tripOutfit.outfitId });
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

/**
 * The outfits on the trip for `day` (null: without a day), which the add
 * page offers disabled. The caller has found the trip to be the owner's.
 */
export async function outfitsOnTripDay(
  db: Db,
  tripId: number,
  day: IsoDate | null,
): Promise<Set<number>> {
  const rows = await db
    .select({ outfitId: tripOutfit.outfitId })
    .from(tripOutfit)
    .where(
      and(
        eq(tripOutfit.tripId, tripId),
        day === null ? isNull(tripOutfit.day) : eq(tripOutfit.day, day),
      ),
    );
  return new Set(rows.map((row) => row.outfitId));
}

/** The outfits of the owner's marked worn on `day`: the trip page's "Worn today". */
export async function outfitsWornOn(
  db: Db,
  ownerId: number,
  day: IsoDate,
): Promise<Set<number>> {
  const rows = await db
    .select({ outfitId: outfitCalendar.outfitId })
    .from(outfitCalendar)
    .where(
      and(
        eq(outfitCalendar.ownerId, ownerId),
        eq(outfitCalendar.day, day),
        isNotNull(outfitCalendar.wornAt),
      ),
    );
  return new Set(rows.map((row) => row.outfitId));
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
 * Adds extras (labels trimmed, never blank) unpacked; a label already on the
 * trip, in any case, adds nothing. The count added; 'not-found' when the
 * trip is not the owner's.
 */
export function addTripItems(
  db: Queryable,
  tripId: number,
  ownerId: number,
  labels: readonly string[],
): Promise<number | 'not-found'> {
  return db.transaction(async (tx) => {
    if (!(await lockTrip(tx, tripId, ownerId))) return 'not-found';
    const values = labels
      .map((label) => label.trim())
      .filter((label) => label.length > 0)
      .map((label) => ({ tripId, label }));
    if (values.length === 0) return 0;
    const inserted = await tx
      .insert(tripItem)
      .values(values)
      .onConflictDoNothing()
      .returning({ id: tripItem.id });
    return inserted.length;
  });
}

/**
 * "Copy extras from a previous trip": the other trip's labels, unpacked, in
 * its order, those this trip has already skipped (so copying twice adds
 * nothing). Both trips must be the owner's; the count added.
 */
export function copyTripItems(
  db: Db,
  input: { fromTripId: number; toTripId: number; ownerId: number },
): Promise<number | 'not-found'> {
  return db.transaction(async (tx) => {
    const from = await findTrip(tx, input.fromTripId, input.ownerId);
    if (!from || input.fromTripId === input.toTripId) return 'not-found';
    const labels = await tx
      .select({ label: tripItem.label })
      .from(tripItem)
      .where(eq(tripItem.tripId, input.fromTripId))
      .orderBy(asc(tripItem.id));
    return addTripItems(
      tx,
      input.toTripId,
      input.ownerId,
      labels.map((row) => row.label),
    );
  });
}

/**
 * The extras' autosave: checked ones packed, shown and unchecked ones not;
 * ids of another trip's extras are ignored. 'not-found' when the trip is
 * not the owner's.
 */
export function setItemsPacked(
  db: Queryable,
  input: {
    tripId: number;
    ownerId: number;
    packed: readonly number[];
    unpacked: readonly number[];
  },
): Promise<{ packed: number; unpacked: number } | 'not-found'> {
  return db.transaction(async (tx) => {
    if (!(await lockTrip(tx, input.tripId, input.ownerId))) return 'not-found';
    const mark = async (ids: readonly number[], packed: boolean) =>
      ids.length === 0
        ? 0
        : (
            await tx
              .update(tripItem)
              .set({ packed })
              .where(
                and(
                  eq(tripItem.tripId, input.tripId),
                  inArray(tripItem.id, [...ids]),
                  eq(tripItem.packed, !packed),
                ),
              )
              .returning({ id: tripItem.id })
          ).length;
    return {
      packed: await mark(input.packed, true),
      unpacked: await mark(input.unpacked, false),
    };
  });
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

/** The owner's other trips that have extras: "Copy extras from". */
export function tripsWithItems(
  db: Db,
  ownerId: number,
  exceptTripId: number,
): Promise<{ id: number; name: string; startsOn: IsoDate; extras: number }[]> {
  return db
    .select({
      id: trip.id,
      name: trip.name,
      startsOn: trip.startsOn,
      extras: sql<number>`count(${tripItem.id})::int`,
    })
    .from(trip)
    .innerJoin(tripItem, eq(tripItem.tripId, trip.id))
    .where(and(eq(trip.ownerId, ownerId), sql`${trip.id} <> ${exceptTripId}`))
    .groupBy(trip.id)
    .orderBy(desc(trip.startsOn), desc(trip.id));
}
