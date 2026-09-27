import {
  DEFAULT_OCCASION,
  isOccasion,
  type Occasion,
} from '../../wardrobe/occasions';
import { type IsoDate, parseIsoDate } from '../calendar/calendar-date';

/**
 * Where a new outfit goes once chosen, carried in URLs as
 * `?for=day:YYYY-MM-DD&occasion=evening` (docs/plans/2026-09-26-redesign.md,
 * section 1, "The destination travels with the user"). The one parser of
 * `?for=`: the calendar's plan page and the builder read it today; Styling
 * (#42), the outfit gallery's Ideas (#9) and Today (#15) import it rather
 * than each parsing the parameter again.
 *
 * Navigation state, so lenient: anything malformed is `none` (the page
 * opens without a destination), never a 400. The write that finally plans
 * the outfit validates its own body.
 *
 * Trips (#10) add `{ kind: 'trip'; tripId; day?; occasion? }` here ("Day
 * 2, dinner"); until then `for=trip:ID` reads as none.
 */
export type OutfitDestination =
  | { kind: 'none' }
  | { kind: 'day'; day: IsoDate; occasion: Occasion };

const DAY_PREFIX = 'day:';

export function parseDestination(query: {
  for?: string;
  occasion?: string;
}): OutfitDestination {
  const target = query.for;
  if (!target?.startsWith(DAY_PREFIX)) return { kind: 'none' };
  const day = parseIsoDate(target.slice(DAY_PREFIX.length));
  if (!day) return { kind: 'none' };
  const occasion =
    query.occasion !== undefined && isOccasion(query.occasion)
      ? query.occasion
      : DEFAULT_OCCASION;
  return { kind: 'day', day, occasion };
}

/**
 * The destination as query parameters (no leading `?`); '' for none. Both
 * values are parsed ones (a real date, a known occasion), so nothing needs
 * encoding, and the URL stays readable (`:` is allowed in a query).
 */
export function destinationQuery(destination: OutfitDestination): string {
  if (destination.kind === 'none') return '';
  return `for=${DAY_PREFIX}${destination.day}&occasion=${destination.occasion}`;
}
