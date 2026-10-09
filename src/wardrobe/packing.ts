import type { IsoDate } from '../calendar-date';
import { type AwayReason, cleanCopies, washLimit } from './availability';
import { topToToe } from './generator';
import type { GarmentRole } from './properties';
import type { GarmentStatus } from './status';

/**
 * A trip's packing list (#10; docs/plans/2026-09-26-wardrobe-features.md,
 * sections 1, 4 and 8), derived from the trip's outfits every time it is
 * read and never stored: the distinct garments those outfits hold, grouped
 * by role, each with the copies to pack and what stands in the way. Only
 * the packed marks are stored (trip_garment_packed), keyed by garment, so
 * they survive any edit that keeps the garment on the list. Pure; the
 * garments' wash state comes from the same rules as everywhere else
 * (src/wardrobe/availability.ts).
 *
 * **The copies-needed rule** (tripWears, copiesNeeded):
 * - A garment is worn at most once a day on a trip, whatever the
 *   occasions: the jeans of Day 2's daytime and its dinner are one wear
 *   (the calendar's rule, "wears count days"). A trip outfit without a day
 *   counts one wear of its own (it is some day of the trip, just not said
 *   which), so five unassigned outfits with the same tee are five wears.
 * - Nothing is washed on the trip, so the wears come out of clean copies:
 *   with a wash limit k a copy lasts k wears, and the trip needs
 *   ceil(wears / k) copies. A garment that is never washed (shoes, a bag;
 *   a limit of null) needs one.
 * - The quantity owned caps what can be packed; the rest is a shortfall
 *   the list warns about ("You own 2, the trip needs 3").
 */

/** One trip outfit that holds the garment: its day of the trip, if it has one. */
export interface GarmentUse {
  day: IsoDate | null;
}

/**
 * The garment's wears on the trip: one per distinct day it is worn, plus
 * one per outfit without a day.
 */
export function tripWears(uses: readonly GarmentUse[]): number {
  const days = new Set(uses.flatMap((use) => use.day ?? []));
  return days.size + uses.filter((use) => use.day === null).length;
}

/**
 * Copies that last `wears` wears without a wash: ceil(wears / limit), one
 * for a garment never washed, none when it is not worn.
 */
export function copiesNeeded(wears: number, limit: number | null): number {
  if (wears === 0) return 0;
  if (limit === null) return 1;
  return Math.ceil(wears / limit);
}

/** A garment on the list, as the database gives it (src/web/trips/packing.ts). */
export interface PackingGarment {
  id: number;
  category: string;
  quantity: number;
  /** garment.wash_after_wears: null for the role's default, NEVER_WASH for never. */
  washAfterWears: number | null;
  /** Distinct days worn since the last wash, now (wearsSinceWashSql). */
  wearsSinceWash: number;
  status: GarmentStatus;
  away: AwayReason | null;
}

/**
 * What stands between the list and the bag:
 * - `too-few`: the trip needs more copies than are owned (`short` more);
 * - `wash`: before departure, fewer clean copies now than the ones to pack
 *   (`clean` of them): wash it before it goes in the bag;
 * - `away`: lent or at the repair shop (src/wardrobe/availability.ts);
 * - `archived`: no longer in the closet, though an outfit still holds it.
 */
export type PackingWarning =
  | { kind: 'too-few'; short: number }
  | { kind: 'wash'; clean: number }
  | { kind: 'away'; reason: AwayReason }
  | { kind: 'archived' };

export interface PackingRow<G extends PackingGarment> {
  garment: G;
  /** Trip outfits that hold it. */
  outfits: number;
  /** tripWears. */
  wears: number;
  /** copiesNeeded: what the trip asks for. */
  needed: number;
  /** What can go in the bag: the copies needed, up to the quantity owned. */
  pack: number;
  packed: boolean;
  warnings: PackingWarning[];
}

export interface PackingGroup<G extends PackingGarment> {
  role: GarmentRole;
  rows: PackingRow<G>[];
}

/** Where the trip stands on `today`: warnings are about a bag still to be packed. */
export type TripPhase = 'upcoming' | 'current' | 'past';

export function tripPhase(
  trip: { startsOn: IsoDate; endsOn: IsoDate },
  today: IsoDate,
): TripPhase {
  if (today < trip.startsOn) return 'upcoming';
  return today > trip.endsOn ? 'past' : 'current';
}

/**
 * Whether a trip outfit can be worn on `today` (its "Wore it"):
 * while the trip is on, and only if it is for today or for no day in
 * particular. The trip page offers the button by it and the wear route
 * refuses by it, so a page left open past midnight cannot mark yesterday's
 * outfit worn today.
 */
export function wearableToday(
  trip: { startsOn: IsoDate; endsOn: IsoDate },
  outfitDay: IsoDate | null,
  today: IsoDate,
): boolean {
  return (
    tripPhase(trip, today) === 'current' &&
    (outfitDay === null || outfitDay === today)
  );
}

export interface PackingList<G extends PackingGarment> {
  groups: PackingGroup<G>[];
  /** Garments on the list, and how many of them are marked packed. */
  garments: number;
  packed: number;
  /** Pieces to pack: every row's `pack`. */
  pieces: number;
  /** Rows with at least one warning. */
  warned: number;
}

/**
 * The list: `garments` in the order given (the caller's reading order),
 * each with its uses (`uses`, by garment id) and packed mark, grouped by
 * role top to toe (OUTFIT_ORDER). Warnings only while the trip is ahead or
 * under way on `today`: a finished trip's list is a record. The wash
 * warning only up to departure (the day itself included: the bag is packed
 * that morning). A garment without uses is left out: it is not on the list
 * (a packed mark for it is an orphan, ignored here and removed by the
 * writers).
 */
export function packingList<G extends PackingGarment>(input: {
  garments: readonly G[];
  uses: ReadonlyMap<number, readonly GarmentUse[]>;
  packed: ReadonlySet<number>;
  trip: { startsOn: IsoDate; endsOn: IsoDate };
  today: IsoDate;
}): PackingList<G> {
  const phase = tripPhase(input.trip, input.today);
  const beforeDeparture = input.today <= input.trip.startsOn;
  const rows: PackingRow<G>[] = [];
  let packed = 0;
  let pieces = 0;
  let warned = 0;
  for (const garment of input.garments) {
    const uses = input.uses.get(garment.id) ?? [];
    if (uses.length === 0) continue;
    const limit = washLimit(garment.category, garment.washAfterWears);
    const wears = tripWears(uses);
    const needed = copiesNeeded(wears, limit);
    const pack = Math.min(needed, garment.quantity);
    const row: PackingRow<G> = {
      garment,
      outfits: uses.length,
      wears,
      needed,
      pack,
      packed: input.packed.has(garment.id),
      warnings:
        phase === 'past'
          ? []
          : packingWarnings(garment, { needed, pack, limit }, beforeDeparture),
    };
    rows.push(row);
    if (row.packed) packed += 1;
    if (row.warnings.length > 0) warned += 1;
    pieces += pack;
  }
  const groups = topToToe(rows, (row) => row.garment.category).map(
    ({ role, items }) => ({ role, rows: items }),
  );
  return {
    groups,
    garments: groups.reduce((sum, group) => sum + group.rows.length, 0),
    packed,
    pieces,
    warned,
  };
}

function packingWarnings(
  garment: PackingGarment,
  need: { needed: number; pack: number; limit: number | null },
  beforeDeparture: boolean,
): PackingWarning[] {
  const warnings: PackingWarning[] = [];
  if (need.needed > garment.quantity) {
    warnings.push({ kind: 'too-few', short: need.needed - garment.quantity });
  }
  if (beforeDeparture) {
    const clean = cleanCopies({
      quantity: garment.quantity,
      limit: need.limit,
      wearsSinceWash: garment.wearsSinceWash,
    });
    if (clean < need.pack) warnings.push({ kind: 'wash', clean });
  }
  if (garment.away !== null) {
    warnings.push({ kind: 'away', reason: garment.away });
  }
  if (garment.status === 'archived') warnings.push({ kind: 'archived' });
  return warnings;
}
