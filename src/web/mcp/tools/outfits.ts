import * as z from 'zod/v4';
import { DEFAULT_OCCASION } from '../../../wardrobe/occasions';
import { findEntries, scheduleOutfit } from '../../calendar/queries';
import {
  isRefused,
  replaceEntryOutfit,
  replaceMessage,
  replaceRefusal,
} from '../../calendar/replace';
import { HttpError } from '../../errors';
import {
  createOutfit,
  findOutfit,
  listOutfits,
  type OutfitSummary,
} from '../../outfits/queries';
import { OUTFIT_NAME_MAX, OUTFIT_NOTES_MAX } from '../../outfits/form-page';
import { findGarment } from '../../wardrobe/queries';
import { defineTool } from '../tool';
import { isoDate, occasionInput, rowId } from './common';

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
      occasion: occasionInput,
    }),
    writes: true,
    idempotent: false,
    async run({ garmentIds, name, notes, scheduleDate, occasion }, ctx) {
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
      // Wishlist items are not owned yet: an outfit never names one (the
      // save would drop it; say so instead).
      const wanted = garments.filter((g) => g!.status === 'wishlist');
      if (wanted.length > 0) {
        throw new HttpError(
          409,
          `On the wishlist, not bought yet: garment ${wanted.map((g) => g!.id).join(', ')}`,
        );
      }
      const plan = scheduleDate
        ? { day: scheduleDate, occasion: occasion ?? DEFAULT_OCCASION }
        : undefined;
      const saved = await createOutfit(ctx.db, ctx.userId, {
        name: name || null,
        notes: notes?.trim() ? notes : null,
        slots: garments.map((garment) => ({
          category: garment!.category,
          garmentId: garment!.id,
        })),
        plan,
      });
      ctx.webLogger.info(
        `Outfit ${saved.id} created by user ${ctx.userId} (MCP): ${saved.slots} slots${plan ? `, planned ${plan.day} (${plan.occasion})` : ''}`,
      );
      return { id: saved.id, scheduled: plan ?? null };
    },
  }),

  defineTool({
    name: 'schedule_outfit',
    title: 'Plan an outfit on a day',
    description:
      "WRITES: plans one of your outfits on a calendar day, for an occasion (the part of the day). A day can hold several outfits (office, then dinner); the same outfit is on a day once, so planning it again changes nothing and it keeps the occasion it has (returned). With replaceEntryId (an entry id from get_calendar or get_today, on that date): changes that entry's outfit instead of adding one, keeping its day and occasion (occasion, if given, must be the entry's); it becomes your choice (plannedBy user), an outfit Plan my week created for it and nothing else uses is removed, and a selfie of it stays on the day as a look. Refused, with nothing changed, when the entry is marked worn (it is the record of that day: add another outfit instead) or the outfit is already on that day. To put an idea from suggest_outfits there, save it first with pick_outfit (no date). Safe to retry.",
    input: z.object({
      outfitId: rowId(),
      date: isoDate().describe('The day, YYYY-MM-DD.'),
      occasion: occasionInput,
      replaceEntryId: rowId()
        .optional()
        .describe(
          'A calendar entry of yours on that date whose outfit this one replaces.',
        ),
    }),
    writes: true,
    idempotent: true,
    async run({ outfitId, date, occasion, replaceEntryId }, ctx) {
      if (replaceEntryId !== undefined) {
        const target = { entryId: replaceEntryId, day: date, occasion };
        const replaced = await replaceEntryOutfit(ctx.db, ctx.userId, target, {
          outfitId,
        });
        ctx.webLogger.info(
          replaceMessage(ctx.userId, target, replaced, ' (MCP)'),
        );
        if (isRefused(replaced)) throw replaceRefusal(replaced);
        return {
          outcome: replaced.outcome,
          date,
          occasion: replaced.occasion,
          entryId: replaced.entryId,
          previousOutfitId: replaced.previousOutfitId,
          selfieKeptAsLook: replaced.selfieDetached !== undefined,
          plannerOutfitRemoved: replaced.outfitsRemoved > 0,
        };
      }
      const planned = occasion ?? DEFAULT_OCCASION;
      const scheduled = await scheduleOutfit(ctx.db, {
        ownerId: ctx.userId,
        outfitId,
        day: date,
        occasion: planned,
      });
      if (scheduled === 'no-such-outfit') {
        throw new HttpError(404, OUTFIT_NOT_FOUND);
      }
      const { outcome } = scheduled;
      // Already there: say which occasion it kept.
      const entry = (await findEntries(ctx.db, ctx.userId, date, date)).find(
        (found) => found.outfit.id === outfitId,
      );
      ctx.webLogger.info(
        `Outfit ${outfitId} ${outcome} on ${date} (${entry?.occasion}) for user ${ctx.userId} (MCP)${outcome === 'already-scheduled' && scheduled.adopted ? "; the week planner's entry is the user's now" : ''}`,
      );
      return { outcome, date, occasion: entry?.occasion ?? planned };
    },
  }),
];
