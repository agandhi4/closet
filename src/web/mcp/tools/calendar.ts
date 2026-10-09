import * as z from 'zod/v4';
import { selectScalars } from '../../../db/select-scalars';
import { compareOccasions } from '../../../wardrobe/occasions';
import { addDays, daysBetween, todayIn } from '../../../calendar-date';
import { entriesSql } from '../../calendar/queries';
import { HttpError } from '../../errors';
import {
  readWeatherWithForecast,
  weatherWithForecastSql,
} from '../../weather/queries';
import { userWeatherFrom } from '../../weather/service';
import {
  laundryList,
  markWashed,
  setEntryWorn,
  setWoreToday,
} from '../../wears/queries';
import { defineTool, wardrobeFor } from '../tool';
import { isoDate, ownerIdInput, rowId } from './common';
import { reachesForecast, weatherOfDays } from './weather';

/** get_calendar's widest range: two months, a planning conversation's horizon. */
const MAX_CALENDAR_DAYS = 62;

/**
 * The calendar and the wears are the caller's own records (src/web/wears):
 * no tool reaches them through a share. Garment-level writes take ownerId
 * only to refuse a shared wardrobe as the pages do (403 where the garment
 * is visible, 404 where it is not).
 */
export const calendarTools = [
  defineTool({
    name: 'get_calendar',
    title: 'Get my calendar',
    description: `Your calendar from one day to another (inclusive, at most ${MAX_CALENDAR_DAYS} days): each entry's id, day, occasion (the part of the day: a day can hold several outfits, listed in occasion order), outfit, whether it was worn, whether you took an outfit selfie of it (a mirror photo; the photo itself is never given), and who planned it (plannedBy: user, or auto for "Plan my week"'s picks, which its daily re-plan may swap until you edit or wear them). Without dates: this week, from today. Days are the household's (its time zone). With weather on and a location set, an entry within the forecast also has the day's weather and what it asks of that occasion's outfit (as get_weather gives it).`,
    input: z.object({
      from: isoDate().optional().describe('First day, YYYY-MM-DD.'),
      to: isoDate().optional().describe('Last day, YYYY-MM-DD.'),
    }),
    writes: false,
    async run({ from, to }, ctx) {
      const now = new Date();
      const today = todayIn(ctx.timeZone, now);
      const first = from ?? today;
      const last = to ?? addDays(first, 6);
      const days = daysBetween(first, last) + 1;
      if (days < 1 || days > MAX_CALENDAR_DAYS) {
        throw new HttpError(
          400,
          `Ask for 1 to ${MAX_CALENDAR_DAYS} days, from before to`,
        );
      }
      // The entries and, when the range reaches the forecast, the settings
      // with their forecast row: one statement (#172; it was two in turn).
      const { weather } = ctx;
      const read = await selectScalars(ctx.db, {
        entries: entriesSql(ctx.userId, first, last),
        weather:
          weather && reachesForecast(today, first, last)
            ? weatherWithForecastSql(ctx.userId, now)
            : undefined,
      });
      const { entries } = read;
      // Only entries carry weather: an empty range never fetches a forecast.
      const weatherOf =
        weather && read.weather !== undefined && entries.length > 0
          ? weatherOfDays(
              await userWeatherFrom(
                weather,
                readWeatherWithForecast(read.weather, now),
                now,
              ),
            )
          : null;
      return {
        today,
        from: first,
        to: last,
        // By day (as read), then occasion, as the calendar page stacks them.
        entries: entries
          .sort(
            (a, b) =>
              a.day.localeCompare(b.day) ||
              compareOccasions(a.occasion, b.occasion),
          )
          .map((entry) => ({
            id: entry.id,
            day: entry.day,
            occasion: entry.occasion,
            worn: entry.worn,
            // Whether a mirror photo was taken (#19); never the image.
            selfie: entry.selfie !== null,
            plannedBy: entry.plannedBy,
            outfit: { id: entry.outfit.id, name: entry.outfit.name },
            weather: weatherOf?.(entry.day, entry.occasion),
          })),
      };
    },
  }),

  defineTool({
    name: 'laundry_status',
    title: 'What needs a wash',
    description:
      'Your garments worn since their last wash that can get dirty, in the closet: those needing a wash first (dirty copies of how many), then those worn but not due yet.',
    input: z.object({}),
    writes: false,
    async run(_args, ctx) {
      const items = await laundryList(ctx.db, ctx.userId);
      return {
        garments: items.map(({ id, name, category, quantity, dirty }) => ({
          id,
          name,
          category,
          quantity,
          dirtyCopies: dirty,
          needsWash: dirty > 0,
        })),
      };
    },
  }),

  defineTool({
    name: 'mark_worn',
    title: 'Mark worn',
    description:
      'WRITES: records a wear. With entryId: marks that calendar entry worn, which records each of its outfit’s garments as worn that day (not for a future day). With garmentId: "Wore today", one garment worn today on its own. Your own records only.',
    input: z
      .object({
        entryId: rowId().optional().describe('A calendar entry id.'),
        garmentId: rowId().optional().describe('One of your garments.'),
        ownerId: ownerIdInput,
      })
      .refine(
        (args) =>
          (args.entryId === undefined) !== (args.garmentId === undefined),
        {
          message: 'Give either entryId or garmentId',
        },
      ),
    writes: true,
    idempotent: true,
    async run({ entryId, garmentId, ownerId }, ctx) {
      const now = new Date();
      const today = todayIn(ctx.timeZone, now);
      if (entryId !== undefined) {
        const outcome = await setEntryWorn(ctx.db, {
          entryId,
          ownerId: ctx.userId,
          worn: true,
          at: now,
          today,
        });
        if (outcome === 'not-found') {
          throw new HttpError(404, 'Calendar entry not found');
        }
        if (outcome === 'future') {
          throw new HttpError(400, 'A day still to come cannot be worn yet');
        }
        ctx.webLogger.info(
          `Calendar entry ${entryId} marked worn by user ${ctx.userId} (MCP): ${outcome.wears} wears`,
        );
        return { entryId, worn: true, garmentsRecorded: outcome.wears };
      }
      // Wears are the owner's own: a shared wardrobe's garment is refused
      // as the garment page's Wore today refuses it.
      await wardrobeFor(ctx, ownerId, 'own');
      const saved = await setWoreToday(ctx.db, {
        garmentId: garmentId!,
        ownerId: ctx.userId,
        day: today,
        worn: true,
      });
      if (saved === 'not-found') throw new HttpError(404, 'Garment not found');
      if (saved === 'wishlist') {
        throw new HttpError(409, 'On the wishlist: not bought yet');
      }
      ctx.webLogger.info(
        `Garment ${garmentId} worn on ${today} by user ${ctx.userId} (MCP)`,
      );
      return { garmentId, day: today };
    },
  }),

  defineTool({
    name: 'mark_washed',
    title: 'Mark washed',
    description:
      'WRITES: marks your garments washed today (every copy, like laundry day); wears today count as before the wash. Ids that are not your garments are ignored. Your own records only.',
    input: z.object({
      garmentIds: z.array(rowId()).min(1).max(500),
      ownerId: ownerIdInput,
    }),
    writes: true,
    idempotent: true,
    async run({ garmentIds, ownerId }, ctx) {
      await wardrobeFor(ctx, ownerId, 'own');
      const today = todayIn(ctx.timeZone, new Date());
      const washed = await markWashed(ctx.db, ctx.userId, garmentIds, today);
      ctx.webLogger.info(
        `Laundry by user ${ctx.userId} on ${today} (MCP): ${washed.length} washed of ${garmentIds.length} asked`,
      );
      return { washed, day: today };
    },
  }),
];
