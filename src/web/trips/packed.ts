import { and, eq, inArray, sql } from 'drizzle-orm';
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
 * src/web/outfits/queries.ts) and by the packing write itself, so a mark
 * left by a race is gone at the trip's next write. The reads join through
 * the list and never show an orphan meanwhile. A module of its own, beside
 * the trip writers, so the outfit writers can call it without importing
 * those (which reach the gallery, which imports the outfit writers).
 */

/**
 * The garments on a trip's list: those in a slot of an outfit on the trip.
 * A subquery, correlated with nothing: `tripId` is a parameter.
 */
function listGarmentIds(tripId: number) {
  return sql`(select ${outfitSlot.garmentId} from ${tripOutfit} inner join ${outfitSlot} on ${outfitSlot.outfitId} = ${tripOutfit.outfitId} where ${tripOutfit.tripId} = ${tripId} and ${outfitSlot.garmentId} is not null)`;
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
 * every garment the list showed. Shown and unchecked are unpacked; checked
 * ones are packed when they are on the trip's list (any other id is
 * ignored, so a mark only ever names a garment of the list, and so of the
 * owner). Under the trip's lock, orphans pruned first. 'not-found' when the
 * trip is not the owner's.
 */
export function setPacked(
  db: Queryable,
  input: {
    tripId: number;
    ownerId: number;
    packed: readonly number[];
    unpacked: readonly number[];
  },
): Promise<PackedChange | 'not-found'> {
  const { tripId } = input;
  return db.transaction(async (tx) => {
    if (!(await lockTrip(tx, tripId, input.ownerId))) return 'not-found';
    await prunePacked(tx, [tripId]);
    const unpacked =
      input.unpacked.length === 0
        ? []
        : await tx
            .delete(tripGarmentPacked)
            .where(
              and(
                eq(tripGarmentPacked.tripId, tripId),
                inArray(tripGarmentPacked.garmentId, [...input.unpacked]),
              ),
            )
            .returning({ id: tripGarmentPacked.garmentId });
    let packed = 0;
    if (input.packed.length > 0) {
      const inserted = await tx.execute(sql`
        insert into ${tripGarmentPacked} (trip_id, garment_id)
        select distinct ${tripId}::int, g.id from ${garment} g
        where g.id in (${sql.join(
          input.packed.map((id) => sql`${id}`),
          sql`, `,
        )})
        and g.id in ${listGarmentIds(tripId)}
        on conflict do nothing`);
      packed = inserted.rowCount ?? 0;
    }
    return { packed, unpacked: unpacked.length };
  });
}
