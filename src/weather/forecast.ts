import type { IsoDate } from '../web/calendar/calendar-date';

/**
 * A forecast as the app keeps and reads it (#14): Open-Meteo's answer
 * normalized by src/web/weather/open-meteo.ts, stored in the cache table
 * (weather_forecast.forecast) and read by the views, the matching
 * (match.ts) and the MCP tool. Every temperature is °C. Days and hours are
 * the household's (APP_TIMEZONE, which the request names), so a forecast
 * day lines up with a calendar day and an hour with an occasion's window
 * (src/wardrobe/occasions.ts). Pure.
 */

/** How far ahead Open-Meteo forecasts; past it the calendar shows no weather. */
export const FORECAST_DAYS = 16;

/**
 * Chance of precipitation (%) from which an hour counts as rainy: the
 * summary's "rain from 3 pm" and the matching's call for water resistance.
 */
export const RAIN_CHANCE = 50;

export interface HourForecast {
  /** 0-23 in APP_TIMEZONE (a DST fall-back day repeats one). */
  hour: number;
  /** Apparent ("feels like") temperature. */
  feelsLike: number;
  /** Chance of precipitation, 0-100. */
  precipitationChance: number;
  /** WMO weather code (conditionOf). */
  code: number;
}

export interface DayForecast {
  day: IsoDate;
  /** The day's WMO weather code: its most significant weather. */
  code: number;
  /** Air temperature. */
  high: number;
  low: number;
  /** The day's highest chance of precipitation, 0-100. */
  precipitationChance: number;
  /** Every hour Open-Meteo gave for the day, in order. */
  hours: HourForecast[];
}

export interface Forecast {
  /** The zone the days and hours are in (the request's APP_TIMEZONE). */
  timeZone: string;
  days: DayForecast[];
}

/** What a day looks like, for its icon and label. */
export const CONDITIONS = [
  'clear',
  'partly-cloudy',
  'cloudy',
  'fog',
  'drizzle',
  'rain',
  'snow',
  'thunderstorm',
] as const;
export type Condition = (typeof CONDITIONS)[number];

// WMO weather codes (the table in Open-Meteo's docs), as ranges.
const CODE_CONDITIONS: readonly [from: number, to: number, Condition][] = [
  [0, 0, 'clear'],
  [1, 2, 'partly-cloudy'],
  [3, 3, 'cloudy'],
  [45, 48, 'fog'],
  [51, 57, 'drizzle'],
  [61, 67, 'rain'],
  [71, 77, 'snow'],
  [80, 82, 'rain'],
  [85, 86, 'snow'],
  [95, 99, 'thunderstorm'],
];

/**
 * A WMO weather code as a condition. Codes outside the table read as
 * cloudy: a new code must not break a page.
 */
export function conditionOf(code: number): Condition {
  const match = CODE_CONDITIONS.find(
    ([from, to]) => code >= from && code <= to,
  );
  return match ? match[2] : 'cloudy';
}

export function forecastDay(
  forecast: Forecast,
  day: IsoDate,
): DayForecast | undefined {
  return forecast.days.find((d) => d.day === day);
}

/**
 * The first hour at or after `fromHour` whose chance of precipitation
 * reaches RAIN_CHANCE, or null: "rain from 3 pm". `fromHour` is now's hour
 * for today (rain that already passed is not news), 0 for a day ahead.
 */
export function rainFrom(day: DayForecast, fromHour: number): number | null {
  const wet = day.hours.find(
    (h) => h.hour >= fromHour && h.precipitationChance >= RAIN_CHANCE,
  );
  return wet ? wet.hour : null;
}

// A clear day's shape: coolest at DAWN_HOUR, warmest at PEAK_HOUR.
const DAWN_HOUR = 6;
const PEAK_HOUR = 15;

/**
 * Where `hour` (0-23) sits between a day's low (0, at 6:00) and high (1, at
 * 15:00): a cosine up through the day and back down overnight. The seed's
 * simulated forecasts (src/seed/weather.ts) and a typical day built from
 * climate normals (src/weather/normals.ts) share it.
 */
export function diurnalPhase(hour: number): number {
  if (hour >= DAWN_HOUR && hour <= PEAK_HOUR) {
    return (
      (1 - Math.cos((Math.PI * (hour - DAWN_HOUR)) / (PEAK_HOUR - DAWN_HOUR))) /
      2
    );
  }
  const since = (hour + 24 - PEAK_HOUR) % 24;
  return (1 + Math.cos((Math.PI * since) / (24 - PEAK_HOUR + DAWN_HOUR))) / 2;
}
