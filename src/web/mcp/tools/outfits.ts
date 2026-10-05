import * as z from 'zod/v4';
import { DEFAULT_OCCASION } from '../../../wardrobe/occasions';
import { scheduleOutfit } from '../../calendar/queries';
import {
  isRefused,
  replaceEntryOutfit,
  replaceMessage,
  replaceRefusal,
} from '../../calendar/replace';
import { HttpError } from '../../errors';
import {
  goneOf,
  namedGarments,
  OutfitGarmentsGone,
} from '../../outfits/gone-garments';
import {
  type CreateResult,
  createOutfit,
  findOutfit,
  listOutfits,
  OUTFIT_GARMENTS_MAX,
  OUTFIT_NAME_MAX,
  OUTFIT_NOTES_MAX,
  type OutfitSummary,
} from '../../outfits/queries';
import { piecesToBuy } from '../../outfits/references';
import { defineTool } from '../tool';
import { isoDate, occasionInput, rowId } from './common';

const OUTFIT_NOT_FOUND = 'Outfit not found';

function outfitOut(outfit: OutfitSummary) {
  return {
    id: outfit.id,
    name: outfit.name,
    notes: outfit.notes,
    garments: outfit.garments.map(({ id, name }) => ({ id, name })),
    // Incomplete (#335): it cannot be planned or packed until these are bought.
    toBuy: piecesToBuy(outfit.garments).map(({ id, name }) => ({ id, name })),
  };
}

/** create_outfit's log line: the outfit made, or the one its garments already were. */
function createdMessage(
  userId: number,
  saved: CreateResult,
  plan: { day: string; occasion: string } | undefined,
): string {
  const what = saved.alreadySaved
    ? `Outfit ${saved.id} of the same garments reused`
    : `Outfit ${saved.id} created (${saved.slots} slots)`;
  const planned = plan
    ? `, ${saved.schedule} ${plan.day} (${plan.occasion})`
    : '';
  const adopted = saved.adopted ? '; taken over from the week planner' : '';
  return `${what} by user ${userId} (MCP)${planned}${adopted}`;
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
      'Your saved outfits, newest first, each with its garments in the order it was built. toBuy lists the garments it holds that are not bought yet (wishlist items): an outfit with any is incomplete, and cannot be planned, added to a trip or worn until they are bought.',
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
    description:
      'One of your outfits: its name, notes and garments, and toBuy: its garments not bought yet (an incomplete outfit cannot be planned, added to a trip or worn).',
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
      'WRITES: saves a new outfit of your own garments, in the order given (outer layer, top, bottom, shoes, accessories reads best), optionally planned on a day as schedule_outfit would. Garments must be in your own wardrobe (clone a shared one first in the app): nothing is saved if any is not. Wishlist items may be in it: the outfit is then incomplete, and cannot be planned (a scheduleDate is refused, nothing saved) until they are bought. If you already have an outfit of exactly these garments it is the answer (alreadySaved: true, its own name and notes kept, nothing created), planned when a date is given, so a retry creates nothing.',
    input: z.object({
      garmentIds: z
        .array(rowId())
        .min(1)
        .max(OUTFIT_GARMENTS_MAX)
        .describe('Your garments, in the order the outfit lists them.'),
      name: z.string().trim().max(OUTFIT_NAME_MAX).optional(),
      notes: z.string().max(OUTFIT_NOTES_MAX).optional(),
      scheduleDate: isoDate()
        .optional()
        .describe('Also plan it on this day (YYYY-MM-DD).'),
      occasion: occasionInput,
    }),
    writes: true,
    // createOutfit reuses an outfit of the same garments: a retry creates nothing.
    idempotent: true,
    async run({ garmentIds, name, notes, scheduleDate, occasion }, ctx) {
      // Each slot is its garment's category, as Styling saves them, read
      // for every garment in one statement (#172: it was one per garment).
      // A garment not the caller's (another's, deleted) refuses the save,
      // named from the same read, as the pages refuse it (#219). A new
      // outfit holds wishlist items too (#335: incomplete); createOutfit
      // checks again as it writes, and refuses planning one.
      const garments = await namedGarments(ctx.db, ctx.userId, garmentIds);
      const gone = goneOf(garments, garmentIds, 'wardrobe');
      if (gone.length > 0) throw new OutfitGarmentsGone(gone);
      const plan = scheduleDate
        ? { day: scheduleDate, occasion: occasion ?? DEFAULT_OCCASION }
        : undefined;
      const saved = await createOutfit(ctx.db, ctx.userId, {
        name: name || null,
        notes: notes?.trim() ? notes : null,
        slots: garmentIds.map((garmentId) => ({
          category: garments.get(garmentId)!.category,
          garmentId,
        })),
        plan,
      });
      ctx.webLogger.info(createdMessage(ctx.userId, saved, plan));
      return {
        id: saved.id,
        name: saved.name,
        alreadySaved: saved.alreadySaved,
        scheduled: plan ?? null,
      };
    },
  }),

  defineTool({
    name: 'schedule_outfit',
    title: 'Plan an outfit on a day',
    description:
      "WRITES: plans one of your outfits on a calendar day, for an occasion (the part of the day). A day can hold several outfits (office, then dinner); the same outfit is on a day once, so planning it again changes nothing and it keeps the occasion it has (returned). With replaceEntryId (an entry id from get_calendar or get_today, on that date): changes that entry's outfit instead of adding one, keeping its day and occasion (occasion, if given, must be the entry's); it becomes your choice (plannedBy user), an outfit Plan my week created for it and nothing else uses is removed, and a selfie of it stays on the day as a look. Refused, with nothing changed, when the entry is marked worn (it is the record of that day: add another outfit instead), the outfit is already on that day, or it is incomplete (toBuy in list_outfits: buy those first). To put an idea from suggest_outfits there, save it first with pick_outfit (no date). Safe to retry.",
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
      // Already there: the occasion it kept.
      const { outcome, occasion: kept } = scheduled;
      ctx.webLogger.info(
        `Outfit ${outfitId} ${outcome} on ${date} (${kept}) for user ${ctx.userId} (MCP)${outcome === 'already-scheduled' && scheduled.adopted ? "; the week planner's entry is the user's now" : ''}`,
      );
      return { outcome, date, occasion: kept };
    },
  }),
];
