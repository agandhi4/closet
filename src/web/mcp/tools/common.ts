import * as z from 'zod/v4';

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
