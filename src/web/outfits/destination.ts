import {
  DEFAULT_OCCASION,
  isOccasion,
  type Occasion,
} from '../../wardrobe/occasions';
import { type IsoDate, parseIsoDate } from '../calendar/calendar-date';

/**
 * Where a new outfit goes once chosen, carried in URLs as
 * `?for=day:YYYY-MM-DD&occasion=evening` or
 * `?for=trip:12[:YYYY-MM-DD][&occasion=evening]`
 * (docs/plans/2026-09-26-redesign.md, section 1, "The destination travels
 * with the user"). The one parser of `?for=`: the calendar's plan page,
 * the builder, the outfit gallery's Ideas (#9), Today (#15) and the trip
 * page (#10) read or write it here rather than each parsing the parameter
 * again.
 *
 * - `day`: planned on the calendar for that day and occasion (all day
 *   without one).
 * - `trip`: added to the trip (#10), optionally for one of its days and an
 *   occasion ("Day 2, dinner"). Both are optional on a trip outfit, so a
 *   trip without either stays without: no occasion is not all day there.
 *   Whether the trip is the requester's, and the day one of its days, is
 *   the reader's check (a trip is data; this only reads the URL).
 *
 * Navigation state, so lenient: anything malformed is `none` (the page
 * opens without a destination), never a 400; a trip's malformed day is no
 * day. The write that finally plans the outfit validates its own body.
 */
export type OutfitDestination =
  | { kind: 'none' }
  | { kind: 'day'; day: IsoDate; occasion: Occasion }
  | TripDestination;

export interface TripDestination {
  kind: 'trip';
  tripId: number;
  day?: IsoDate;
  occasion?: Occasion;
}

const DAY_PREFIX = 'day:';
const TRIP_PREFIX = 'trip:';
// A serial id (32-bit, as RowId), then optionally one of the trip's days.
const TRIP_TARGET = /^trip:(\d{1,10})(?::(.+))?$/;
const MAX_ID = 2_147_483_647;

export function parseDestination(query: {
  for?: string;
  occasion?: string;
}): OutfitDestination {
  const target = query.for;
  const occasion =
    query.occasion !== undefined && isOccasion(query.occasion)
      ? query.occasion
      : undefined;
  if (target?.startsWith(DAY_PREFIX)) {
    const day = parseIsoDate(target.slice(DAY_PREFIX.length));
    if (!day) return { kind: 'none' };
    return { kind: 'day', day, occasion: occasion ?? DEFAULT_OCCASION };
  }
  const trip =
    target === undefined ? undefined : parseTripTarget(target, occasion);
  return trip ?? { kind: 'none' };
}

/** `trip:ID[:YYYY-MM-DD]`, or undefined when it is not one. */
function parseTripTarget(
  target: string,
  occasion: Occasion | undefined,
): TripDestination | undefined {
  const trip = TRIP_TARGET.exec(target);
  const tripId = trip ? Number(trip[1]) : 0;
  if (!trip || tripId < 1 || tripId > MAX_ID) return undefined;
  const day = parseIsoDate(trip[2]);
  return {
    kind: 'trip',
    tripId,
    ...(day && { day }),
    ...(occasion && { occasion }),
  };
}

/**
 * The destination as query parameters (no leading `?`); '' for none. The
 * values are parsed ones (a real date, a known occasion, an id), so nothing
 * needs encoding, and the URL stays readable (`:` is allowed in a query).
 */
export function destinationQuery(destination: OutfitDestination): string {
  if (destination.kind === 'none') return '';
  const target = `for=${destinationTarget(destination)}`;
  return destination.occasion
    ? `${target}&occasion=${destination.occasion}`
    : target;
}

/** The `for` value alone, as a write's hidden field posts it back. */
export function destinationTarget(
  destination: Exclude<OutfitDestination, { kind: 'none' }>,
): string {
  return destination.kind === 'day'
    ? `${DAY_PREFIX}${destination.day}`
    : `${TRIP_PREFIX}${destination.tripId}${destination.day ? `:${destination.day}` : ''}`;
}
