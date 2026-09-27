import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { file, garment, tripGarmentPacked, tripOutfit } from '../../db/schema';
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
import { wearsSinceWashSql } from '../wears/queries';
import {
  findTrip,
  outfitsWornOn,
  tripDays,
  type TripItemRow,
  tripItems,
  type TripRow,
} from './queries';

/**
 * A trip as its page and get_trip read it (#10): the trip, its days with
 * their outfits (occasion order), the outfits without a day, the packing
 * list (derived: src/wardrobe/packing.ts over the outfits' garments, their
 * wash state now and their packed marks), the extras, and which outfits
 * were worn today. Five statements, whatever the trip holds.
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

/** The trip's outfits with their garments in slot order, sorted for reading. */
async function tripOutfitViews(
  db: Db,
  tripId: number,
): Promise<TripOutfitView[]> {
  const rows = await db.query.tripOutfit.findMany({
    columns: { id: true, day: true, occasion: true },
    where: eq(tripOutfit.tripId, tripId),
    with: {
      outfit: {
        columns: { id: true, name: true },
        with: {
          slots: {
            columns: {},
            where: (slot, { isNotNull }) => isNotNull(slot.garmentId),
            orderBy: (slot, { asc }) => [asc(slot.position)],
            with: {
              garment: {
                columns: { id: true, name: true, category: true },
                with: { photo: { columns: { fileName: true, version: true } } },
              },
            },
          },
        },
      },
    },
  });
  return rows
    .map((row) => ({
      id: row.id,
      outfitId: row.outfit.id,
      name: row.outfit.name,
      day: row.day,
      occasion: row.occasion,
      garments: row.outfit.slots.flatMap(({ garment: g }) => (g ? [g] : [])),
    }))
    .sort(byDayAndOccasion);
}

/**
 * The garments of the list with what the rule reads (quantity, wash limit,
 * wears since the wash now, status, away) and their packed mark, in the
 * order `ids` gives. One statement.
 */
async function packingGarments(
  db: Db,
  tripId: number,
  ownerId: number,
  ids: readonly number[],
): Promise<{ garments: PackingGarmentView[]; packed: Set<number> }> {
  if (ids.length === 0) return { garments: [], packed: new Set() };
  const rows = await db
    .select({
      id: garment.id,
      name: garment.name,
      category: garment.category,
      quantity: garment.quantity,
      washAfterWears: garment.washAfterWears,
      status: garment.status,
      away: garment.away,
      photo: { fileName: file.fileName, version: file.version },
      wearsSinceWash: wearsSinceWashSql(),
      packed: sql<boolean>`exists (select 1 from ${tripGarmentPacked} where ${tripGarmentPacked.tripId} = ${tripId} and ${tripGarmentPacked.garmentId} = ${garment.id})`,
    })
    .from(garment)
    .leftJoin(file, eq(file.id, garment.photoId))
    .where(and(eq(garment.ownerId, ownerId), inArray(garment.id, [...ids])));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const garments = ids.flatMap((id): PackingGarmentView[] => {
    const row = byId.get(id);
    return row
      ? [
          {
            id: row.id,
            name: row.name,
            category: row.category,
            quantity: row.quantity,
            washAfterWears: row.washAfterWears,
            status: row.status,
            away: row.away,
            photo: row.photo,
            wearsSinceWash: row.wearsSinceWash,
          },
        ]
      : [];
  });
  return {
    garments,
    packed: new Set(rows.filter((row) => row.packed).map((row) => row.id)),
  };
}

/** The owner's trip on `today`; undefined when it is not theirs. */
export async function tripModel(
  db: Db,
  ownerId: number,
  tripId: number,
  today: IsoDate,
): Promise<TripModel | undefined> {
  const trip = await findTrip(db, tripId, ownerId);
  if (!trip) return undefined;
  const phase = tripPhase(trip, today);
  const [outfits, items, wornToday] = await Promise.all([
    tripOutfitViews(db, tripId),
    tripItems(db, tripId),
    phase === 'current'
      ? outfitsWornOn(db, ownerId, today)
      : Promise.resolve(new Set<number>()),
  ]);
  // Each garment's uses, in reading order (the order the list keeps).
  const uses = new Map<number, GarmentUse[]>();
  for (const view of outfits) {
    for (const g of new Map(view.garments.map((g) => [g.id, g])).values()) {
      uses.set(g.id, [...(uses.get(g.id) ?? []), { day: view.day }]);
    }
  }
  const { garments, packed } = await packingGarments(db, tripId, ownerId, [
    ...uses.keys(),
  ]);
  const days = tripDays(trip).map((day) => ({
    day,
    outfits: outfits.filter((o) => o.day === day),
  }));
  return {
    trip,
    today,
    phase,
    days,
    undated: outfits.filter((o) => o.day === null),
    packing: packingList({ garments, uses, packed, trip, today }),
    items,
    wornToday,
  };
}
