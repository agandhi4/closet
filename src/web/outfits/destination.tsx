import { Type } from '@sinclair/typebox';
import {
  DEFAULT_OCCASION,
  isOccasion,
  type Occasion,
} from '../../wardrobe/occasions';
import { dayOfWeek, type IsoDate, parseIsoDate } from '../../calendar-date';
import { DAY_NAMES } from '../date-labels';
import { t } from '../i18n';
import { OccasionSchema, RowId } from '../schemas';

/**
 * Where a new outfit goes once chosen, carried in URLs as
 * `?for=day:YYYY-MM-DD&occasion=evening[&replace=<entry id>]` or
 * `?for=trip:12[:YYYY-MM-DD][&occasion=evening]`
 * (docs/plans/2026-09-26-redesign.md, section 1, "The destination travels
 * with the user"). The one parser and writer of `?for=`: the calendar's plan
 * page, Styling (#42), the outfit gallery's Ideas (#9), Today (#15) and the
 * trip page (#10) read it (parseDestination, DestinationQuery), link it
 * (destinationQuery), post it back (DestinationFields, DestinationBody) and
 * name where a pick goes (destinationPickLabel) here, never each on its own:
 * until 2026-10-17 the hidden fields, the query schema and the label were
 * each written in two to five features (docs/decisions.md).
 *
 * - `day`: planned on the calendar for that day and occasion (all day
 *   without one). With `replace` (#69) it is a change of that entry's
 *   outfit rather than one more entry: Today's "Change", the calendar row's
 *   Change and the plan page carry it, and the writes that plan (POST
 *   /calendar, the gallery's pick, Styling's Save) hand it to
 *   replaceEntryOutfit (src/web/calendar/replace.ts), which checks that the
 *   entry is the requester's, on that day and for that occasion.
 * - `trip`: added to the trip (#10), optionally for one of its days and an
 *   occasion ("Day 2, dinner"). Both are optional on a trip outfit, so a
 *   trip without either stays without: no occasion is not all day there.
 *   Whether the trip is the requester's, and the day one of its days, is
 *   the reader's check (a trip is data; this only reads the URL).
 *
 * Navigation state, so lenient: anything malformed is `none` (the page
 * opens without a destination), never a 400; a trip's malformed day is no
 * day, and a malformed `replace` is dropped. The write that finally plans
 * the outfit validates its own body.
 */
export type OutfitDestination =
  | { kind: 'none' }
  | DayDestination
  | TripDestination;

export interface DayDestination {
  kind: 'day';
  day: IsoDate;
  occasion: Occasion;
  /** The entry of that day and occasion whose outfit a pick replaces (#69). */
  replace?: number;
}

interface TripDestination {
  kind: 'trip';
  tripId: number;
  day?: IsoDate;
  occasion?: Occasion;
}

const DAY_PREFIX = 'day:';
const TRIP_PREFIX = 'trip:';
// A serial id (32-bit, as RowId), then optionally one of the trip's days.
const TRIP_TARGET = /^trip:(\d{1,10})(?::(.+))?$/;
const ENTRY_ID = /^[1-9]\d{0,9}$/;
const MAX_ID = 2_147_483_647;

export function parseDestination(query: {
  for?: string;
  occasion?: string;
  /** A string in a URL; a number from a write's schema (RowId coerces). */
  replace?: string | number;
}): OutfitDestination {
  const target = query.for;
  const occasion =
    query.occasion !== undefined && isOccasion(query.occasion)
      ? query.occasion
      : undefined;
  if (target?.startsWith(DAY_PREFIX)) {
    const day = parseIsoDate(target.slice(DAY_PREFIX.length));
    if (!day) return { kind: 'none' };
    const destination = {
      kind: 'day',
      day,
      occasion: occasion ?? DEFAULT_OCCASION,
    } as const;
    const replace = parseEntryId(query.replace);
    return replace === undefined ? destination : { ...destination, replace };
  }
  const trip =
    target === undefined ? undefined : parseTripTarget(target, occasion);
  return trip ?? { kind: 'none' };
}

/** A calendar entry id, as RowId; undefined when it is not one. */
function parseEntryId(value: string | number | undefined): number | undefined {
  if (value === undefined || !ENTRY_ID.test(String(value))) return undefined;
  const id = Number(value);
  return id <= MAX_ID ? id : undefined;
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
  const query = destination.occasion
    ? `${target}&occasion=${destination.occasion}`
    : target;
  return destination.kind === 'day' && destination.replace !== undefined
    ? `${query}&replace=${destination.replace}`
    : query;
}

/** The `for` value alone, as a write's hidden field posts it back. */
export function destinationTarget(
  destination: Exclude<OutfitDestination, { kind: 'none' }>,
): string {
  return destination.kind === 'day'
    ? `${DAY_PREFIX}${destination.day}`
    : `${TRIP_PREFIX}${destination.tripId}${destination.day ? `:${destination.day}` : ''}`;
}

/**
 * `?for=&occasion=&replace=` as a page's query string schema: navigation
 * state, so plain strings that parseDestination judges (anything malformed
 * is `none`, never a 400). Spread into a route's querystring object.
 */
export const DestinationQuery = {
  for: Type.Optional(Type.String()),
  occasion: Type.Optional(Type.String()),
  replace: Type.Optional(Type.String()),
};

/**
 * The same three as a write posts them back (DestinationFields), stored
 * data, so strict: `for` is the shape destinationTarget writes (the
 * pattern mirrors DAY_PREFIX and TRIP_TARGET; parseDestination then checks
 * the dates), the occasion a known one, `replace` a row id. The gallery's
 * pick and Styling's Save; postedDestination (src/web/gallery/pick.ts)
 * refuses a `for` that does not read back as posted.
 */
export const DestinationBody = {
  for: Type.Optional(
    Type.String({
      pattern:
        '^(day:\\d{4}-\\d{2}-\\d{2}|trip:\\d{1,10}(:\\d{4}-\\d{2}-\\d{2})?)$',
    }),
  ),
  occasion: Type.Optional(OccasionSchema),
  replace: Type.Optional(RowId),
};

/**
 * The destination as a form's hidden fields (DestinationBody's names), so a
 * write's redirect comes back to the same place; nothing for `none`.
 */
export function DestinationFields(props: { destination: OutfitDestination }) {
  const { destination } = props;
  if (destination.kind === 'none') return null;
  return (
    <>
      <input type="hidden" name="for" value={destinationTarget(destination)} />
      {destination.occasion && (
        <input type="hidden" name="occasion" value={destination.occasion} />
      )}
      {destination.kind === 'day' && destination.replace !== undefined && (
        <input
          type="hidden"
          name="replace"
          value={String(destination.replace)}
        />
      )}
    </>
  );
}

/**
 * What the primary action does with the outfit, by where it goes: "Add to
 * trip", "Plan for Tuesday" or, with `replace`, the change's own word. The
 * caller names the `none` case (the gallery saves, Styling saves an outfit).
 */
export function destinationPickLabel(
  destination: Exclude<OutfitDestination, { kind: 'none' }>,
): string {
  if (destination.kind === 'trip') return t('gallery.PICK_TRIP');
  return destination.replace === undefined
    ? t('gallery.PICK_DAY', {
        weekday: t(DAY_NAMES[dayOfWeek(destination.day)]),
      })
    : t('changeEntry.PICK');
}
