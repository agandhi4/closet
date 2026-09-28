import { and, eq, type SQL, sql } from 'drizzle-orm';
import type { Queryable } from '../../db/client';
import {
  garment,
  outfitSlot,
  trip,
  tripGarmentPacked,
  tripOutfit,
} from '../../db/schema';

/**
 * The packed marks of a trip's garments (trip_garment_packed): the one piece
 * of the packing list that is stored (the list itself is derived,
 * src/wardrobe/packing.ts). A mark is kept while its garment is on the list,
 * whatever else changes, and removed with the garment when it leaves:
 * prunePacked is called by every writer that can take a garment off a
 * trip's list (removing a trip outfit here, an outfit's edit and deletion in
 * src/web/outfits/queries.ts), and the packing write prunes in its own
 * statement, so a mark left by a race is gone at the trip's next packing
 * write or outfit removal. The reads join through
 * the list and never show an orphan meanwhile. A module of its own, beside
 * the trip writers, so the outfit writers can call it without importing
 * those (which reach the gallery, which imports the outfit writers).
 */

/**
 * The garments on a trip's list: those in a slot of an outfit on the trip.
 * A subquery, correlated with nothing: `tripId` is a parameter. setPacked
 * and the packing list's read (tripModel, model.ts).
 */
export function listGarmentIdsSql(tripId: number): SQL {
  return sql`(select ${outfitSlot.garmentId} from ${tripOutfit} inner join ${outfitSlot} on ${outfitSlot.outfitId} = ${tripOutfit.outfitId} where ${tripOutfit.tripId} = ${tripId} and ${outfitSlot.garmentId} is not null)`;
}

/**
 * lockTrip as the first CTE of a trip write that is one statement:
 * `locked`, one row (id, starts_on, ends_on) when the trip is the owner's,
 * locked like lockTrip. Every write of the statement reads it (joins it, or
 * asks `exists (select 1 from locked)`, uncorrelated, which Postgres
 * evaluates once before scanning), so the trip's lock comes before any row
 * the statement changes, the order every trip write keeps. A statement is
 * one round trip where a transaction is four (#166: begin, the lock, the
 * write, commit).
 *
 * **The statement reads rows as they were before it waited for the lock**
 * (READ COMMITTED: one snapshot per statement; only the locked trip row is
 * re-read). So only a write whose outcome does not hang on trip rows
 * another trip writer adds meanwhile is one statement: the extras' writers
 * (unique labels are the index's), addTripOutfit (the dates are the locked
 * row's) and setPacked (a mark raced onto a garment that just left the
 * list is one the reads never show, as prunePacked says). updateTrip's
 * writes and removeTripOutfit's prune judge the trip's outfits, so they
 * run in a statement after the one that locks, in its transaction.
 */
export function lockedTripCte(tripId: number, ownerId: number): SQL {
  return sql`locked as (
    select ${trip.id} as id, ${trip.startsOn} as starts_on, ${trip.endsOn} as ends_on
    from ${trip}
    where ${and(eq(trip.id, tripId), eq(trip.ownerId, ownerId))}
    for no key update
  )`;
}

/** Ids as a Postgres int[] (an empty one included), for `= any(...)`. */
export function intArray(ids: readonly number[]): SQL {
  return sql`array[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::int[]`;
}

/** Deletes the marks of `tripIds` whose garment is on none of the trip's outfits; the count. */
export async function prunePacked(
  tx: Queryable,
  tripIds: readonly number[],
): Promise<number> {
  if (tripIds.length === 0) return 0;
  const pruned = await tx.execute(sql`
    delete from ${tripGarmentPacked} as p
    where p.trip_id in (${sql.join(
      tripIds.map((id) => sql`${id}`),
      sql`, `,
    )})
    and not exists (
      select 1 from ${tripOutfit} o
      inner join ${outfitSlot} s on s.outfit_id = o.outfit_id
      where o.trip_id = p.trip_id and s.garment_id = p.garment_id
    )`);
  return pruned.rowCount ?? 0;
}

/** The trips an outfit is on, for its writers to prune after changing it. */
export async function tripsOfOutfit(
  tx: Queryable,
  outfitId: number,
): Promise<number[]> {
  const rows = await tx
    .selectDistinct({ id: tripOutfit.tripId })
    .from(tripOutfit)
    .where(eq(tripOutfit.outfitId, outfitId));
  return rows.map((row) => row.id);
}

/**
 * Locks the owner's trip for a write (FOR NO KEY UPDATE: the trip's writers
 * take turns, and rows referencing it may still be inserted by the one
 * holding the lock); undefined when it is not theirs.
 */
export async function lockTrip(
  tx: Queryable,
  tripId: number,
  ownerId: number,
): Promise<{ startsOn: string; endsOn: string } | undefined> {
  const [row] = await tx
    .select({ startsOn: trip.startsOn, endsOn: trip.endsOn })
    .from(trip)
    .where(and(eq(trip.id, tripId), eq(trip.ownerId, ownerId)))
    .for('no key update');
  return row;
}

export interface PackedChange {
  packed: number;
  unpacked: number;
}

/**
 * The packing list's autosave: `packed` are the checked garments, `shown`
 * every garment the list showed. Shown and unchecked are unpacked (a
 * garment in both lists ends packed); checked ones are packed when they
 * are on the trip's list (any other id is ignored, so a mark only ever
 * names a garment of the list, and so of the owner), and the marks of
 * garments off the list pruned. One statement under the trip's lock
 * (lockedTripCte), its three writes on disjoint rows: the prune only off
 * the list, the rest only on it. 'not-found' when the trip is not the
 * owner's.
 */
export async function setPacked(
  db: Queryable,
  input: {
    tripId: number;
    ownerId: number;
    packed: readonly number[];
    unpacked: readonly number[];
  },
): Promise<PackedChange | 'not-found'> {
  const { tripId } = input;
  const packed = intArray(input.packed);
  const locked = sql`exists (select 1 from locked)`;
  const onList = sql`${tripGarmentPacked.garmentId} in ${listGarmentIdsSql(tripId)}`;
  const { rows } = await db.execute<{
    found: boolean;
    packed: number;
    unpacked: number;
  }>(sql`
    with ${lockedTripCte(tripId, input.ownerId)},
    pruned as (
      delete from ${tripGarmentPacked}
      where ${tripGarmentPacked.tripId} = ${tripId} and ${locked} and not ${onList}
    ),
    unpacked as (
      delete from ${tripGarmentPacked}
      where ${tripGarmentPacked.tripId} = ${tripId} and ${locked} and ${onList}
      and ${tripGarmentPacked.garmentId} = any(${intArray(input.unpacked)})
      and not ${tripGarmentPacked.garmentId} = any(${packed})
      returning 1
    ),
    packed as (
      insert into ${tripGarmentPacked} (trip_id, garment_id)
      select distinct locked.id, g.id from locked, ${garment} g
      where g.id = any(${packed}) and g.id in ${listGarmentIdsSql(tripId)}
      on conflict do nothing
      returning 1
    )
    select exists (select 1 from locked) as found,
      (select count(*)::int from packed) as packed,
      (select count(*)::int from unpacked) as unpacked`);
  const [{ found, ...change }] = rows;
  return found ? change : 'not-found';
}
