import { and, eq, type SQL, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  file,
  garment,
  outfit,
  tripGarmentPacked,
  tripOutfit,
} from '../../db/schema';
import { selectScalars } from '../../db/select-scalars';
import { compareOccasions, type Occasion } from '../../wardrobe/occasions';
import {
  type GarmentUse,
  type PackingGarment,
  type PackingList,
  packingList,
  type TripPhase,
  tripPhase,
} from '../../wardrobe/packing';
import type { IsoDate } from '../calendar/calendar-date';
import type { ImageRef } from '../files/image-url';
import type { CollageGarment } from '../outfits/collage';
import { outfitGarmentsSql } from '../outfits/queries';
import { wearsSinceWashSql } from '../wears/queries';
import { listGarmentIdsSql } from './packed';
import {
  outfitsWornOnSql,
  ownTripSql,
  type TripCopySource,
  tripDays,
  type TripItemRow,
  tripItemsSql,
  type TripRow,
  tripRow,
  tripsWithItemsSql,
} from './queries';

/**
 * A trip as its page and get_trip read it (#10): the trip, its days with
 * their outfits (occasion order), the outfits without a day, the packing
 * list (derived: src/wardrobe/packing.ts over the outfits' garments, their
 * wash state now and their packed marks), the extras, and which outfits
 * were worn today. **One statement, whatever the trip holds** (#166;
 * selectScalars: five before, one round trip each on production's link):
 * every part is a subquery scoped to the owner, so another user's trip
 * reads nothing but the null that makes it a 404.
 */

/** An outfit on the trip, with its garments for the collage. */
export interface TripOutfitView {
  /** The trip_outfit row's id (removing it, "Wearing this today"). */
  id: number;
  outfitId: number;
  name: string | null;
  day: IsoDate | null;
  occasion: Occasion | null;
  garments: CollageGarment[];
}

export interface TripDay {
  day: IsoDate;
  outfits: TripOutfitView[];
}

/** A garment on the packing list, as the page and the tool show it. */
export interface PackingGarmentView extends PackingGarment {
  name: string | null;
  photo: ImageRef | null;
}

export interface TripModel {
  trip: TripRow;
  today: IsoDate;
  phase: TripPhase;
  days: TripDay[];
  /** Outfits for the trip but no day of it ("Any day"). */
  undated: TripOutfitView[];
  packing: PackingList<PackingGarmentView>;
  items: TripItemRow[];
  /** Outfit ids with a worn calendar entry today (only while the trip is on). */
  wornToday: ReadonlySet<number>;
}

/** Day order, then occasion order (an unsaid occasion last), then as added. */
function byDayAndOccasion(a: TripOutfitView, b: TripOutfitView): number {
  if (a.day !== b.day) {
    if (a.day === null) return 1;
    if (b.day === null) return -1;
    return a.day < b.day ? -1 : 1;
  }
  if (a.occasion !== b.occasion) {
    if (a.occasion === null) return 1;
    if (b.occasion === null) return -1;
    return compareOccasions(a.occasion, b.occasion);
  }
  return a.id - b.id;
}

/**
 * The trip's outfits (the owner's: a trip only ever holds its owner's) with
 * their garments in slot order, as a scalar subquery; sorted for reading
 * in tripModel.
 */
function tripOutfitViewsSql(
  tripId: number,
  ownerId: number,
): SQL<TripOutfitView[]> {
  return sql<TripOutfitView[]>`(
    select coalesce(
      json_agg(json_build_object(
        'id', ${tripOutfit.id},
        'outfitId', ${outfit.id},
        'name', ${outfit.name},
        'day', ${tripOutfit.day},
        'occasion', ${tripOutfit.occasion},
        'garments', ${outfitGarmentsSql()}
      )),
      '[]'
    )
    from ${tripOutfit}
    inner join ${outfit} on ${eq(outfit.id, tripOutfit.outfitId)}
    where ${and(eq(tripOutfit.tripId, tripId), eq(outfit.ownerId, ownerId))}
  )`;
}

/** A packing list garment as packingGarmentsSql reads it: the rule's inputs and the mark. */
type PackingGarmentRow = PackingGarmentView & { packed: boolean };

/**
 * The owner's garments on the trip's list (in a slot of one of its
 * outfits) with what the rule reads (quantity, wash limit, wears since the
 * wash now, status, away) and their packed mark, as a scalar subquery.
 * The list's order is the outfits' (tripModel).
 */
function packingGarmentsSql(
  tripId: number,
  ownerId: number,
): SQL<PackingGarmentRow[]> {
  return sql<PackingGarmentRow[]>`(
    select coalesce(
      json_agg(json_build_object(
        'id', ${garment.id},
        'name', ${garment.name},
        'category', ${garment.category},
        'quantity', ${garment.quantity},
        'washAfterWears', ${garment.washAfterWears},
        'status', ${garment.status},
        'away', ${garment.away},
        'photo', case when ${file.id} is null then null else json_build_object(
          'fileName', ${file.fileName}, 'version', ${file.version}
        ) end,
        'wearsSinceWash', ${wearsSinceWashSql()},
        'packed', exists (
          select 1 from ${tripGarmentPacked}
          where ${tripGarmentPacked.tripId} = ${tripId}
          and ${tripGarmentPacked.garmentId} = ${garment.id}
        )
      )),
      '[]'
    )
    from ${garment}
    left join ${file} on ${eq(file.id, garment.photoId)}
    where ${eq(garment.ownerId, ownerId)}
    and ${garment.id} in ${listGarmentIdsSql(tripId)}
  )`;
}

/** The owner's trip on `today`; undefined when it is not theirs. */
export async function tripModel(
  db: Db,
  ownerId: number,
  tripId: number,
  today: IsoDate,
): Promise<TripModel | undefined> {
  const found = await readTrip(db, ownerId, tripId, today, false);
  return found?.model;
}

/**
 * tripModel and "Copy extras from"'s other trips, the trip page's whole
 * read, in the same one statement.
 */
export async function tripPageModel(
  db: Db,
  ownerId: number,
  tripId: number,
  today: IsoDate,
): Promise<(TripModel & { copyFrom: TripCopySource[] }) | undefined> {
  const found = await readTrip(db, ownerId, tripId, today, true);
  return found && { ...found.model, copyFrom: found.copyFrom };
}

async function readTrip(
  db: Db,
  ownerId: number,
  tripId: number,
  today: IsoDate,
  withCopyFrom: boolean,
): Promise<{ model: TripModel; copyFrom: TripCopySource[] } | undefined> {
  const row = await selectScalars(db, {
    trip: ownTripSql(tripId, ownerId),
    outfits: tripOutfitViewsSql(tripId, ownerId),
    garments: packingGarmentsSql(tripId, ownerId),
    items: tripItemsSql(tripId, ownerId),
    // Read whatever the phase (which needs the trip's dates): a lookup on
    // the owner's day, used only while the trip is on.
    wornToday: outfitsWornOnSql(ownerId, today),
    copyFrom: withCopyFrom ? tripsWithItemsSql(ownerId, tripId) : undefined,
  });
  if (!row.trip) return undefined;
  const trip = tripRow(row.trip);
  const phase = tripPhase(trip, today);
  const outfits = row.outfits.sort(byDayAndOccasion);
  // Each garment's uses, in reading order (the order the list keeps).
  const uses = new Map<number, GarmentUse[]>();
  for (const view of outfits) {
    for (const g of new Map(view.garments.map((g) => [g.id, g])).values()) {
      uses.set(g.id, [...(uses.get(g.id) ?? []), { day: view.day }]);
    }
  }
  const byId = new Map(row.garments.map((g) => [g.id, g]));
  const garments = [...uses.keys()].flatMap((id): PackingGarmentView[] => {
    const g = byId.get(id);
    return g
      ? [
          {
            id: g.id,
            name: g.name,
            category: g.category,
            quantity: g.quantity,
            washAfterWears: g.washAfterWears,
            status: g.status,
            away: g.away,
            photo: g.photo,
            wearsSinceWash: g.wearsSinceWash,
          },
        ]
      : [];
  });
  const packed = new Set(row.garments.filter((g) => g.packed).map((g) => g.id));
  const days = tripDays(trip).map((day) => ({
    day,
    outfits: outfits.filter((o) => o.day === day),
  }));
  return {
    model: {
      trip,
      today,
      phase,
      days,
      undated: outfits.filter((o) => o.day === null),
      packing: packingList({ garments, uses, packed, trip, today }),
      items: row.items,
      wornToday: new Set(phase === 'current' ? row.wornToday : []),
    },
    copyFrom: row.copyFrom ?? [],
  };
}
