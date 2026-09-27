import {
  addDays,
  dateParts,
  type IsoDate,
} from '../web/calendar/calendar-date';
import { type DayForecast, diurnalPhase, RAIN_CHANCE } from './forecast';

/**
 * Climate normals (#14's "typical" days, for #10's trips; plan section 7):
 * what a calendar day is usually like at a place, for the days past the
 * 16-day forecast. Built from the place's observed days over the last
 * NORMAL_YEARS whole years (Open-Meteo's historical archive, ERA5;
 * src/web/weather/open-meteo.ts), averaged per calendar day over a window of
 * NORMAL_WINDOW_DAYS either side, so each day's normal rests on about 150
 * observations and a single odd year does not show. Every temperature is
 * °C. Pure.
 *
 * Only a trip's far days read them (src/web/trips/forecast.ts, and ideas for
 * such a day through IdeasInput.place): Today, the calendar, the weekly
 * plan and its re-plan stay forecast-only, since a typical day is not a
 * forecast and must never swap a planned outfit.
 */

/** Whole years of observations the normals average. */
export const NORMAL_YEARS = 10;
/** Days either side of a calendar day that count toward its normal. */
export const NORMAL_WINDOW_DAYS = 7;
/**
 * Precipitation (mm) from which an observed day counts as wet: the WMO's
 * "rain day" threshold. A day's rain chance is the share of wet days.
 */
export const WET_DAY_MM = 1;

/** 'MM-DD': a calendar day of any year ('02-29' included). */
export type MonthDay = string;

export interface DayNormals {
  /** Mean daily air temperature high and low. */
  high: number;
  low: number;
  /** Mean daily feels-like (apparent temperature) high and low. */
  feelsHigh: number;
  feelsLow: number;
  /** The share of days that were wet (WET_DAY_MM or more), 0-100. */
  rainChance: number;
}

export interface ClimateNormals {
  /** The whole years observed, inclusive. */
  years: { first: number; last: number };
  /** Every calendar day that had observations in its window. */
  days: Record<MonthDay, DayNormals>;
}

/** One observed day, as the archive gives it (missing values already left out). */
export interface ObservedDay {
  day: IsoDate;
  high: number;
  low: number;
  feelsHigh: number;
  feelsLow: number;
  /** Total precipitation, mm. */
  precipitation: number;
}

/**
 * The NORMAL_YEARS whole years before `today`'s: the newest complete
 * record (the archive trails today by a few days), and the same range all
 * year, so the answer only changes on New Year.
 */
export function normalYears(today: IsoDate): { first: number; last: number } {
  const last = dateParts(today).year - 1;
  return { first: last - NORMAL_YEARS + 1, last };
}

export function monthDayOf(day: IsoDate): MonthDay {
  const { month, day: date } = dateParts(day);
  return `${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;
}

// Every calendar day in order, 02-29 in its place: a leap year's days.
const CALENDAR: readonly MonthDay[] = Array.from({ length: 366 }, (_, i) =>
  monthDayOf(addDays('2024-01-01', i)),
);

/**
 * The normals of `observed` (any order; days outside `years` are the
 * caller's to leave out). A calendar day's window wraps the year: 1 January
 * averages late December too.
 */
export function climateNormals(
  observed: readonly ObservedDay[],
  years: { first: number; last: number },
): ClimateNormals {
  const byMonthDay = new Map<MonthDay, ObservedDay[]>();
  for (const day of observed) {
    const key = monthDayOf(day.day);
    const bucket = byMonthDay.get(key) ?? [];
    bucket.push(day);
    byMonthDay.set(key, bucket);
  }
  const days: Record<MonthDay, DayNormals> = {};
  CALENDAR.forEach((monthDay, index) => {
    const samples: ObservedDay[] = [];
    for (let d = -NORMAL_WINDOW_DAYS; d <= NORMAL_WINDOW_DAYS; d += 1) {
      const key = CALENDAR[(index + d + CALENDAR.length) % CALENDAR.length];
      samples.push(...(byMonthDay.get(key) ?? []));
    }
    if (samples.length === 0) return;
    const mean = (pick: (day: ObservedDay) => number) =>
      round1(samples.reduce((sum, day) => sum + pick(day), 0) / samples.length);
    const wet = samples.filter((day) => day.precipitation >= WET_DAY_MM);
    days[monthDay] = {
      high: mean((day) => day.high),
      low: mean((day) => day.low),
      feelsHigh: mean((day) => day.feelsHigh),
      feelsLow: mean((day) => day.feelsLow),
      rainChance: Math.round((100 * wet.length) / samples.length),
    };
  });
  return { years, days };
}

export function normalsOn(
  normals: ClimateNormals,
  day: IsoDate,
): DayNormals | undefined {
  return normals.days[monthDayOf(day)];
}

// WMO codes for a typical day: it says only whether rain (or snow) is usual.
const TYPICAL_CODE = { dry: 2, rain: 63, snow: 73 };

/**
 * A typical `day` as a forecast day, so the matching (weatherNeeds,
 * assessOutfit) judges it with the same inputs as a forecast day. The
 * approximation:
 * - the hours' feels-like follow a clear day's curve (diurnalPhase) from
 *   the normal feels-like low at 6:00 to the normal high at 15:00. Real
 *   days vary around it; the normal is their middle;
 * - every hour's chance of precipitation is the day's rain chance, so a
 *   typical day asks for water resistance only where most days are wet
 *   (RAIN_CHANCE), as a forecast hour does;
 * - the hours are read as the household's hours (APP_TIMEZONE), as the
 *   forecast's are: the curve is not shifted for a destination in another
 *   zone;
 * - the condition is only dry, rain or snow (snow when it would be wet and
 *   the high feels below 1 °C).
 */
export function typicalDay(day: IsoDate, normals: DayNormals): DayForecast {
  const wet = normals.rainChance >= RAIN_CHANCE;
  const code = !wet
    ? TYPICAL_CODE.dry
    : normals.feelsHigh < 1
      ? TYPICAL_CODE.snow
      : TYPICAL_CODE.rain;
  const swing = normals.feelsHigh - normals.feelsLow;
  return {
    day,
    code,
    high: normals.high,
    low: normals.low,
    precipitationChance: normals.rainChance,
    hours: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      feelsLike: round1(normals.feelsLow + swing * diurnalPhase(hour)),
      precipitationChance: normals.rainChance,
      code,
    })),
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
