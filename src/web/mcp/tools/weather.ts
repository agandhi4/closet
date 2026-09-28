import * as z from 'zod/v4';
import type { Occasion } from '../../../wardrobe/occasions';
import {
  conditionOf,
  type DayForecast,
  FORECAST_DAYS,
  rainFrom,
} from '../../../weather/forecast';
import { type WeatherNeeds, weatherNeeds } from '../../../weather/match';
import {
  addDays,
  daysBetween,
  type IsoDate,
  todayIn,
} from '../../calendar/calendar-date';
import { HttpError } from '../../errors';
import type { TripTypicalDay } from '../../trips/forecast';
import { userWeather, type UserWeather } from '../../weather/service';
import { defineTool } from '../tool';
import { isoDate, occasionInput } from './common';

/**
 * The weather tools (#14), listed only with WEATHER_ENABLED (mcpTools,
 * ./index.ts). The user's own location and forecast, as on their pages;
 * get_calendar and get_today add the same day summaries (weatherOfDays).
 */

const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * A day's weather and what it asks of an outfit for `occasion`, for someone
 * whose personal offset is `offset`: the matching's needs
 * (src/weather/match.ts) in a tool's words.
 */
export function dayWeather(
  day: DayForecast,
  occasion: Occasion,
  offset: number,
) {
  const needs = weatherNeeds(day, occasion, offset);
  return {
    day: day.day,
    condition: conditionOf(day.code),
    highC: round1(day.high),
    lowC: round1(day.low),
    precipitationChance: day.precipitationChance,
    rainFromHour: rainFrom(day, 0),
    outfit: needs && outfitNeeds(needs),
  };
}

/**
 * A trip day past the forecast (get_trip): the destination's climate
 * normals, marked `typical` so no agent reads them as a forecast, and what
 * a typical day asks of an all-day outfit.
 */
export function typicalDayWeather({ day, normals, needs }: TripTypicalDay) {
  return {
    day,
    typical: true,
    highC: round1(normals.high),
    lowC: round1(normals.low),
    feelsLikeC: {
      min: round1(normals.feelsLow),
      max: round1(normals.feelsHigh),
    },
    rainChance: normals.rainChance,
    outfit: needs && outfitNeeds(needs),
  };
}

/** What a day asks of an outfit for its occasion, in a tool's words. */
function outfitNeeds(needs: WeatherNeeds) {
  return {
    occasion: needs.occasion,
    hours: needs.window,
    feelsLikeC: {
      min: round1(needs.feelsLike.min),
      max: round1(needs.feelsLike.max),
    },
    torsoWarmth: needs.torso,
    torsoWarmthWithoutLayer: needs.torsoWithoutLayer,
    legsAndFeetWarmth: needs.limbs,
    needsLayer: needs.layer,
    needsWaterResistance: needs.rain,
  };
}

/** The last day the forecast reaches from `today`. */
function horizon(today: IsoDate): IsoDate {
  return addDays(today, FORECAST_DAYS - 1);
}

/** Whether the days `first` to `last` reach into the forecast from `today`. */
export function reachesForecast(
  today: IsoDate,
  first: IsoDate,
  last: IsoDate,
): boolean {
  return last >= today && first <= horizon(today);
}

/** A day's weather for an occasion (dayWeather), or undefined past the forecast. */
export type DayWeatherOf = (
  day: IsoDate,
  occasion: Occasion,
) => ReturnType<typeof dayWeather> | undefined;

/**
 * The weather of each day for get_calendar's entries and get_today, from
 * the user's weather their tool already read in its own statement: null
 * when there is nothing to add (weather off, no location, no answer from
 * Open-Meteo yet).
 */
export function weatherOfDays(
  weather: UserWeather | null | undefined,
): DayWeatherOf | null {
  if (!weather?.cached) return null;
  const { settings, cached } = weather;
  return (day, occasion) => {
    const forecast = cached.forecast.days.find((d) => d.day === day);
    return forecast && dayWeather(forecast, occasion, settings.offset);
  };
}

export const weatherTools = [
  defineTool({
    name: 'get_weather',
    title: 'Get my weather',
    description: `The forecast where you are (your home city, or the phone's location while it is fresh), from today up to ${FORECAST_DAYS} days ahead (without dates: this week), and what each day asks of an outfit for an occasion (all-day when omitted): the occasion's hours and their feels-like range (°C, your personal offset included), the torso warmth to reach (top plus layer combined, 1-9, where a garment's warmth is 1-5: a tee 2, a sweater 4, a jacket 3, a parka 5), that warmth without the layer for the warmest hours, the warmth for legs and feet (1-5), whether a layer that comes off is needed, and whether rain asks for a water-resistant layer, footwear or accessory. Temperatures are °C; "unit" is how the user reads them.`,
    input: z.object({
      from: isoDate().optional().describe('First day, YYYY-MM-DD, from today.'),
      to: isoDate()
        .optional()
        .describe(
          `Last day, YYYY-MM-DD, at most ${FORECAST_DAYS - 1} days after today.`,
        ),
      occasion: occasionInput,
    }),
    writes: false,
    async run({ from, to, occasion = 'all-day' }, ctx) {
      // Listed only with a service (mcpTools).
      const service = ctx.weather!;
      const now = new Date();
      const today = todayIn(ctx.timeZone, now);
      const first = from ?? today;
      const last = to ?? addDays(first, 6);
      if (
        first < today ||
        last > horizon(today) ||
        daysBetween(first, last) < 0
      ) {
        throw new HttpError(
          400,
          `Ask for days from ${today} to ${horizon(today)}, from before to`,
        );
      }
      const { settings, active, cached } = await userWeather(
        ctx.db,
        service,
        ctx.userId,
        now,
      );
      if (!active) {
        return {
          location: null,
          note: 'No location set: the user sets a home city (or uses their location) in the app, under Profile, Weather.',
        };
      }
      const location = { name: active.name, source: active.source };
      if (!cached) {
        return {
          location,
          forecast: null,
          note: 'The forecast is not available right now; try again later.',
        };
      }
      return {
        today,
        location,
        unit: settings.unit,
        temperatureOffsetC: settings.offset,
        fetchedAt: cached.fetchedAt.toISOString(),
        days: cached.forecast.days
          .filter((day) => day.day >= first && day.day <= last)
          .map((day) => dayWeather(day, occasion, settings.offset)),
      };
    },
  }),
];
