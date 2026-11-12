import * as z from 'zod';
import { OCCASIONS } from '../../../wardrobe/occasions';

/**
 * Input pieces the tools share. Ids are Postgres serials (32-bit), as the
 * routes' RowId (src/web/schemas.ts); a larger number is refused by the
 * schema, not failed in the query.
 */

export const rowId = () => z.number().int().min(1).max(2_147_483_647);

export const ownerIdInput = rowId()
  .optional()
  .describe(
    "A wardrobe shared with you: its owner's id, from list_shared_wardrobes. Omit for your own.",
  );

/** A calendar day, 'YYYY-MM-DD' (a real date, like the routes' IsoDateSchema). */
export const isoDate = () => z.iso.date();

/**
 * A price in US dollars, as the tools take it: numeric(10, 2) holds 8
 * digits before the point. Posted to the form's readPrice as `toFixed(2)`.
 */
export const priceInput = () => z.number().nonnegative().max(99_999_999);

/**
 * priceInput in whole cents: a stored price (update_garment) is refused
 * rather than rounded by `toFixed(2)`. Exact up to the float error of the
 * number sent (0.1 + 0.2 is 30 cents; 19.999 is refused).
 */
export const centsPriceInput = () =>
  priceInput().refine(
    (dollars) => {
      const cents = dollars * 100;
      return Math.abs(cents - Math.round(cents)) <= cents * 4 * Number.EPSILON;
    },
    { message: 'At most two decimals (whole cents)' },
  );

/** A calendar entry's occasion (src/wardrobe/occasions.ts); all day when omitted. */
export const occasionInput = z
  .enum(OCCASIONS)
  .optional()
  .describe(
    `The part of the day it is for: ${OCCASIONS.join(', ')}. Omit for all-day.`,
  );
