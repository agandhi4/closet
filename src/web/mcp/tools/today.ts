import * as z from 'zod/v4';
import { DEFAULT_OCCASION } from '../../../wardrobe/occasions';
import { ideaName } from '../../gallery/ideas';
import { todayFor } from '../../today/today';
import { defineTool } from '../tool';
import { calendarWeather } from './weather';

/**
 * Today (#15) as data: the same model the home screen renders (todayFor),
 * so an agent and the page never disagree about what is planned or
 * suggested. The caller's own day, like the calendar: no ownerId.
 */
export const todayTools = [
  defineTool({
    name: 'get_today',
    title: 'Get today',
    description:
      "Today as the app's home screen shows it: the date (the household's), whether anything is marked worn yet, and a row per occasion planned today with its outfits (entry and outfit ids, worn or not, garments). While nothing that dresses the day (all-day, work, daytime) is planned, an all-day row of three suggestions comes first (the same ideas as suggest_outfits for today, the day's seed, page 1): to wear one, plan it for today with pick_outfit (date: today) and mark that entry worn with mark_worn (get_today then lists it planned). With weather on and a location set, what today asks of an all-day outfit.",
    input: z.object({}),
    writes: false,
    async run(_args, ctx) {
      const model = await todayFor(
        { db: ctx.db, weather: ctx.weather, timeZone: ctx.timeZone },
        ctx.userId,
        new Date(),
      );
      const weather = await calendarWeather(ctx, model.today, model.today);
      return {
        day: model.today,
        wornToday: model.wornToday,
        weather: weather?.(model.today, DEFAULT_OCCASION) ?? null,
        rows: model.rows.map((row) =>
          row.kind === 'planned'
            ? {
                occasion: row.occasion,
                planned: row.entries.map((entry) => ({
                  entryId: entry.id,
                  outfitId: entry.outfit.id,
                  name: entry.outfit.name,
                  worn: entry.worn,
                  garments: entry.outfit.garments.map((g) => ({
                    id: g.id,
                    name: g.name,
                    category: g.category,
                  })),
                })),
              }
            : {
                occasion: row.occasion,
                suggestions: row.ideas.map((idea) => ({
                  name: ideaName(idea.garments),
                  garmentIds: idea.garments.map((g) => g.id),
                  fits: idea.score === 0,
                  problems: idea.problems,
                })),
              },
        ),
      };
    },
  }),
];
