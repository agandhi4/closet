import * as z from 'zod';
import { OCCASIONS } from '../../../wardrobe/occasions';
import { ROW_ID_MAX } from '../../schemas';
import {
  GRID_CURSOR_PATTERN,
  type GridCursor,
  readGridCursor,
} from '../../wardrobe/grid-cursor';

/**
 * Input pieces the tools share. Ids are Postgres serials (32-bit), as the
 * routes' RowId (src/web/schemas.ts); a larger number is refused by the
 * schema, not failed in the query.
 */

export const rowId = () => z.number().int().min(1).max(ROW_ID_MAX);

export const ownerIdInput = rowId()
  .optional()
  .describe(
    "A wardrobe shared with you: its owner's id, from list_shared_wardrobes. Omit for your own.",
  );

/**
 * A garment list's page cursor (search_garments, get_capsule): the previous
 * answer's `next`, a string (GridCursor's text), or a bare id as answers
 * before #784 gave it, which is the same cursor (rank 0).
 */
export const pageCursorInput = z
  .union([rowId(), z.string().regex(GRID_CURSOR_PATTERN)])
  .optional()
  .describe(
    "The previous page's `next`, passed back as it came (a bare garment id also reads).",
  );

/** The cursor pageCursorInput names; a rank no page answers is a 400. */
export function readPageCursor(
  before: number | string | undefined,
): GridCursor | undefined {
  if (before === undefined) return undefined;
  return typeof before === 'number'
    ? { rank: 0, id: before }
    : readGridCursor(before);
}

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
