import * as z from 'zod/v4';
import { DEFAULT_OCCASION, OCCASION_HINTS } from '../../../wardrobe/occasions';
import { todayIn } from '../../calendar/calendar-date';
import { HttpError } from '../../errors';
import { OUTFIT_COUNT_CAP } from '../../../wardrobe/goes-with';
import {
  dailySeed,
  goesWithCloset,
  IDEAS_PAGE_SIZE,
  ideaName,
  ideasFor,
  ideasScope,
  MAX_SEED,
  pickIdea,
} from '../../gallery/ideas';
import { OUTFIT_NAME_MAX } from '../../outfits/queries';
import { defineTool } from '../tool';
import { isoDate, occasionInput, rowId } from './common';

const round1 = (value: number) => Math.round(value * 10) / 10;

/** Ideas per call at most: a page, or a few for a quick answer. */
const MAX_IDEAS = 12;

/** A garment as the tools name it. */
const named = (g: { id: number; name: string | null; category: string }) => ({
  id: g.id,
  name: g.name,
  category: g.category,
});

/**
 * The outfit generator's tools (#9): the same ideas as the Outfits page's
 * Ideas tab (ideasFor: the available closet, the weather, the occasion's
 * formality, avoided pairs, saved outfits skipped) and the same pick; and
 * "Goes with my closet" (#18b: goesWithCloset, as a wishlist item's page
 * shows it). The caller's own, like outfits: no ownerId.
 */
export const galleryTools = [
  defineTool({
    name: 'suggest_outfits',
    title: 'Suggest outfits',
    description: `Whole-outfit ideas from your own closet for a day and an occasion (today, all-day when omitted): top, bottom and shoes (or a dress and shoes), a layer when the weather asks for one, from garments that are clean and at home, favouring what you have worn least recently. At most two colours beyond the neutrals and one patterned piece; never a pair you said clashes; never an outfit you already saved. Each idea says why: how it meets the forecast (when weather is on and the day is within the forecast) and the occasion's formality, and which garments it brings back into rotation. Optionally always with one garment (withGarmentId, "style this") or only from a capsule. Seeded: the same seed and page give the same ideas; another seed gives others. Save one with pick_outfit.`,
    input: z.object({
      date: isoDate()
        .optional()
        .describe('The day to dress for, YYYY-MM-DD. Omit for today.'),
      occasion: occasionInput,
      withGarmentId: rowId()
        .optional()
        .describe('A garment of yours in the closet that every idea includes.'),
      capsuleId: rowId()
        .optional()
        .describe('Only garments of this capsule of yours (list_capsules).'),
      seed: z
        .number()
        .int()
        .min(0)
        .max(MAX_SEED)
        .optional()
        .describe("Which ideas. Omit for the day's; the answer says which."),
      page: z.number().int().min(1).max(50).optional(),
      limit: z.number().int().min(1).max(MAX_IDEAS).optional(),
    }),
    writes: false,
    async run(
      {
        date,
        occasion = DEFAULT_OCCASION,
        withGarmentId,
        capsuleId,
        seed,
        page = 1,
        limit = IDEAS_PAGE_SIZE,
      },
      ctx,
    ) {
      const now = new Date();
      const today = todayIn(ctx.timeZone, now);
      const day = date ?? today;
      const { capsule, styled } = await ideasScope(ctx.db, ctx.userId, {
        capsuleId,
        withId: withGarmentId,
        today,
      });
      const usedSeed = seed ?? dailySeed(today);
      const result = await ideasFor(
        { db: ctx.db, weather: ctx.weather },
        ctx.userId,
        {
          today,
          day,
          occasion,
          capsuleId: capsule?.id,
          locked: styled ? [styled] : [],
          seed: usedSeed,
          offset: (page - 1) * limit,
          limit,
        },
        now,
      );
      const needs = result.weather?.needs;
      return {
        day,
        occasion,
        seed: usedSeed,
        page,
        more: result.more,
        formality: OCCASION_HINTS[occasion].formality,
        weather: needs
          ? {
              feelsLikeC: {
                min: round1(needs.feelsLike.min),
                max: round1(needs.feelsLike.max),
              },
              needsLayer: needs.layer,
              needsWaterResistance: needs.rain,
            }
          : null,
        ideas: result.ideas.map((idea) => ({
          name: ideaName(idea.garments),
          garmentIds: idea.garments.map((g) => g.id),
          garments: idea.garments.map((g) => ({
            id: g.id,
            name: g.name,
            category: g.category,
            daysUnworn: g.idleDays,
          })),
          fits: idea.score === 0,
          problems: idea.problems,
          rotation: idea.garments
            .filter((g) => idea.rested.includes(g.id))
            .map((g) => g.name ?? g.category),
        })),
      };
    },
  }),

  defineTool({
    name: 'goes_with_closet',
    title: 'Goes with my closet',
    description: `Judges one of your wishlist items (list_wishlist) against your whole closet, as its page in the app does: how many distinct outfits it makes with what you own (counted up to ${OUTFIT_COUNT_CAP}; capped: true means more), the best few (those dressed at the item's own formality first), each role it is worn with (how many of your bottoms, shoes, layers... go with it, and the best of them), and the closet garments near-identical to it (same category, type and colours: "do I need this?"; replacesIt marks the one it is on the wishlist to replace). The same rules as suggest_outfits (colours, patterns, your clashes), but not the weather or an occasion: a purchase is worn across seasons. Outfits here cannot be saved with pick_outfit until the item is bought (Bought it, in the app).`,
    input: z.object({
      garmentId: rowId().describe('The wishlist item, from list_wishlist.'),
    }),
    writes: false,
    async run({ garmentId }, ctx) {
      const today = todayIn(ctx.timeZone, new Date());
      const result = await goesWithCloset(ctx.db, ctx.userId, garmentId, today);
      if (!result) throw new HttpError(404, 'Not on your wishlist');
      return {
        item: named(result.item),
        outfits: {
          count: result.outfits,
          capped: result.capped,
          cap: OUTFIT_COUNT_CAP,
        },
        best: result.best.map((idea) => ({
          name: ideaName(idea.garments),
          garments: idea.garments.map(named),
          atItemsFormality: idea.score === 0,
        })),
        pairsWith: result.roles.map((role) => ({
          role: role.role,
          goWithIt: role.goes,
          inCloset: role.of,
          best: role.best.map((partner) => ({
            ...named(partner.garment),
            outfits: partner.outfits,
          })),
        })),
        nearDuplicates: result.nearDuplicates.map((garment) => ({
          ...named(garment),
          type: garment.type,
          colors: garment.colors,
          replacesIt: garment.replaced,
        })),
        note: 'Display only: pick_outfit takes closet garments, so these become outfits after Bought it.',
      };
    },
  }),

  defineTool({
    name: 'pick_outfit',
    title: 'Save an outfit idea',
    description:
      'WRITES: saves an idea from suggest_outfits (its garmentIds) as a new outfit of yours, named after its garments unless you give a name, and, with a date, plans it on that day for the occasion (all-day when omitted), all at once. The garments must be yours and in the closet. Safe to retry: if you already have an outfit of exactly these garments, it is reused (alreadySaved: true, nothing created) and only planned when a date is given.',
    input: z.object({
      garmentIds: z
        .array(rowId())
        .min(1)
        .max(8)
        .describe("The idea's garmentIds."),
      date: isoDate()
        .optional()
        .describe('Also plan it on this day (YYYY-MM-DD).'),
      occasion: occasionInput,
      name: z.string().trim().min(1).max(OUTFIT_NAME_MAX).optional(),
    }),
    writes: true,
    // pickIdea reuses an outfit of the same garments: a retry creates nothing.
    idempotent: true,
    async run({ garmentIds, date, occasion = DEFAULT_OCCASION, name }, ctx) {
      const plan = date ? { day: date, occasion } : undefined;
      const picked = await pickIdea(ctx.db, ctx.userId, {
        garmentIds,
        plan,
        name,
      });
      if (picked === 'not-found') {
        throw new HttpError(404, 'A garment is not in your closet');
      }
      ctx.webLogger.info(
        `Idea picked by user ${ctx.userId} (MCP): ${picked.alreadySaved ? `already outfit ${picked.id}, nothing created` : `outfit ${picked.id}`} of garments ${garmentIds.join(', ')}${plan ? `, ${picked.schedule} ${plan.day} (${plan.occasion})` : ''}${picked.adopted ? '; taken over from the week planner' : ''}`,
      );
      return {
        id: picked.id,
        name: picked.name,
        alreadySaved: picked.alreadySaved,
        scheduled: plan ? { ...plan, outcome: picked.schedule } : null,
      };
    },
  }),
];
