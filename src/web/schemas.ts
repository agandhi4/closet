import { Type } from '@sinclair/typebox';
import { OCCASIONS } from '../wardrobe/occasions';

/**
 * Request schema pieces more than one feature validates with (TypeBox, see
 * CLAUDE.md, Web layer: Validation).
 */

/**
 * A row id in a path or a form: Postgres serials are 32-bit, so anything
 * larger would fail in the query as a 500 instead of here as a 400.
 */
export const RowId = Type.Integer({ minimum: 1, maximum: 2_147_483_647 });

/**
 * A calendar day, 'YYYY-MM-DD'. `format: 'date'` is ajv-formats' full-date
 * (a real calendar date), the rule parseIsoDate (src/web/calendar/
 * calendar-date.ts) applies to query parameters that fall back instead.
 */
export const IsoDateSchema = Type.String({ format: 'date' });

/**
 * A calendar entry's occasion (src/wardrobe/occasions.ts) in a form: POST
 * /calendar and the outfit form. Anything else is a 400: it is data a write
 * stores (a `?occasion=` in a URL is navigation state, parseDestination's).
 */
export const OccasionSchema = Type.Union(
  OCCASIONS.map((occasion) => Type.Literal(occasion)),
);

/**
 * Where a write plans what it saves (OutfitDestination, src/web/outfits/
 * destination.ts), as a form posts it back: `for` (`day:D` or
 * `trip:ID[:D]`), its occasion and the entry it replaces (#69, a day's
 * only). The gallery's pick and Styling's Save; postedDestination
 * (src/web/gallery/pick.ts) checks that `for` reads back as posted.
 */
export const DestinationFields = {
  for: Type.Optional(
    Type.String({
      pattern:
        '^(day:\\d{4}-\\d{2}-\\d{2}|trip:\\d{1,10}(:\\d{4}-\\d{2}-\\d{2})?)$',
    }),
  ),
  occasion: Type.Optional(OccasionSchema),
  replace: Type.Optional(RowId),
};
