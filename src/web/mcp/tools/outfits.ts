import * as z from 'zod/v4';
import type { IsoDate } from '../../calendar/calendar-date';
import { findEntries, scheduleOutfit } from '../../calendar/queries';
import { HttpError } from '../../errors';
import {
  createOutfit,
  findOutfit,
  listOutfits,
  type OutfitSummary,
} from '../../outfits/queries';
import { OUTFIT_NAME_MAX, OUTFIT_NOTES_MAX } from '../../outfits/form-page';
import { findGarment } from '../../wardrobe/queries';
import { defineTool, type ToolContext } from '../tool';
import { isoDate, rowId } from './common';

const OUTFIT_NOT_FOUND = 'Outfit not found';

function outfitOut(outfit: OutfitSummary) {
  return {
    id: outfit.id,
    name: outfit.name,
    notes: outfit.notes,
    garments: outfit.garments.map(({ id, name }) => ({ id, name })),
  };
}

/**
 * Outfits and the calendar are private (src/web/outfits): these tools read
 * and write the caller's own, whatever wardrobes are shared with them, and
 * take no ownerId.
 */
export const outfitTools = [
  defineTool({
    name: 'list_outfits',
    title: 'List my outfits',
    description:
      'Your saved outfits, newest first, each with its garments in the order it was built.',
    input: z.object({}),
    writes: false,
    async run(_args, ctx) {
      const outfits = await listOutfits(ctx.db, ctx.userId);
      return { outfits: outfits.map(outfitOut) };
    },
  }),

  defineTool({
    name: 'get_outfit',
    title: 'Get an outfit',
    description: 'One of your outfits: its name, notes and garments.',
    input: z.object({ id: rowId().describe('The outfit id.') }),
    writes: false,
    async run({ id }, ctx) {
      const outfit = await findOutfit(ctx.db, id, ctx.userId);
      if (!outfit) throw new HttpError(404, OUTFIT_NOT_FOUND);
      return outfitOut(outfit);
    },
  }),

  defineTool({
    name: 'create_outfit',
    title: 'Create an outfit',
    description:
      'WRITES: saves a new outfit of your own garments, in the order given (outer layer, top, bottom, shoes, accessories reads best), optionally planned on a day as schedule_outfit would. Garments must be in your own wardrobe (clone a shared one first in the app).',
    input: z.object({
      garmentIds: z
        .array(rowId())
        .min(1)
        .max(20)
        .describe('Your garments, in the order the outfit lists them.'),
      name: z.string().trim().max(OUTFIT_NAME_MAX).optional(),
      notes: z.string().max(OUTFIT_NOTES_MAX).optional(),
      scheduleDate: isoDate()
        .optional()
        .describe('Also plan it on this day (YYYY-MM-DD).'),
    }),
    writes: true,
    idempotent: false,
    async run({ garmentIds, name, notes, scheduleDate }, ctx) {
      // Each slot is its garment's category, as the builder's rows are. A
      // garment that is not the caller's is refused here rather than
      // saved as an empty slot (the form's rule for a stale page).
      const garments = await Promise.all(
        garmentIds.map((id) => findGarment(ctx.db, id, ctx.userId)),
      );
      const missing = garmentIds.filter((_id, i) => !garments[i]);
      if (missing.length > 0) {
        throw new HttpError(
          404,
          `Not in your wardrobe: garment ${missing.join(', ')}`,
        );
      }
      if (scheduleDate) await refuseTakenDay(ctx, scheduleDate, undefined);
      const saved = await createOutfit(ctx.db, ctx.userId, {
        name: name || null,
        notes: notes?.trim() ? notes : null,
        slots: garments.map((garment) => ({
          category: garment!.category,
          garmentId: garment!.id,
        })),
        scheduleDate,
      });
      ctx.webLogger.info(
        `Outfit ${saved.id} created by user ${ctx.userId} (MCP): ${saved.slots} slots${scheduleDate ? `, planned ${scheduleDate}` : ''}`,
      );
      return { id: saved.id, scheduled: scheduleDate ?? null };
    },
  }),

  defineTool({
    name: 'schedule_outfit',
    title: 'Plan an outfit on a day',
    description:
      'WRITES: plans one of your outfits on a calendar day. One outfit a day: a day that already has another outfit is refused (say which to keep in the app). Planning the same outfit again changes nothing.',
    input: z.object({
      outfitId: rowId(),
      date: isoDate().describe('The day, YYYY-MM-DD.'),
    }),
    writes: true,
    idempotent: true,
    async run({ outfitId, date }, ctx) {
      await refuseTakenDay(ctx, date, outfitId);
      const outcome = await scheduleOutfit(ctx.db, {
        ownerId: ctx.userId,
        outfitId,
        day: date,
      });
      if (outcome === 'no-such-outfit') {
        throw new HttpError(404, OUTFIT_NOT_FOUND);
      }
      ctx.webLogger.info(
        `Outfit ${outfitId} ${outcome} on ${date} for user ${ctx.userId} (MCP)`,
      );
      return { outcome, date };
    },
  }),
];

/**
 * One outfit a day until occasions (#13) let an entry say which part of the
 * day it is for: then this becomes "one per occasion", and schedule_outfit
 * and create_outfit take the occasion. The calendar itself allows several
 * (its key is owner, day, outfit); an agent adding a second without an
 * occasion would only make the day ambiguous.
 */
async function refuseTakenDay(
  ctx: ToolContext,
  day: IsoDate,
  outfitId: number | undefined,
): Promise<void> {
  const entries = await findEntries(ctx.db, ctx.userId, day, day);
  const other = entries.find((entry) => entry.outfit.id !== outfitId);
  if (other) {
    throw new HttpError(
      409,
      `${day} already has outfit ${other.outfit.id} (${other.outfit.name ?? 'untitled'}) planned`,
    );
  }
}
