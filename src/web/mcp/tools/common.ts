import * as z from 'zod/v4';
import { OCCASIONS } from '../../../wardrobe/occasions';
import {
  CANDIDATE_NOTE_MAX,
  MAX_CANDIDATES_PER_ITEM,
} from '../../plans/candidates';

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

/** A calendar entry's occasion (src/wardrobe/occasions.ts); all day when omitted. */
export const occasionInput = z
  .enum(OCCASIONS)
  .optional()
  .describe(
    `The part of the day it is for: ${OCCASIONS.join(', ')}. Omit for all-day.`,
  );

/** A candidate's research (#293), as add_candidate, update_candidate and add_garment_from_link take it. */
export const candidateNoteInput = z
  .string()
  .trim()
  .min(1)
  .max(CANDIDATE_NOTE_MAX)
  .describe(
    `Why this option fits the item, in at most ${CANDIDATE_NOTE_MAX} characters, shown under it in the app: material, fit and sizing, price against the budget, how it pairs with the closet.`,
  );

export const candidateRankInput = z
  .number()
  .int()
  .min(1)
  .max(MAX_CANDIDATES_PER_ITEM)
  .describe(
    `Your place for this option among the item's options: 1 is your pick (the owner sees it first, marked as yours), up to ${MAX_CANDIDATES_PER_ITEM}.`,
  );
