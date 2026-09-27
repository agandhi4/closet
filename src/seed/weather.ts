import {
  addDays,
  addMonths,
  dateParts,
  daysInMonth,
  type IsoDate,
} from '../web/calendar/calendar-date';
import type { DayForecast, HourForecast } from '../weather/forecast';
import { fahrenheitToCelsius } from '../weather/temperature';
import { stream } from './random';

/**
 * A plausible New York day for the seed's simulated history: pure, no
 * network. Central Park's 1991-2020 normal highs, interpolated between month
 * mid-points, plus an AR(1) anomaly so warm and cool spells last a few days,
 * humidity on hot days, and rain by the month's odds. The personas' outfits
 * are chosen by the day's band (demo.md, Simulation), not by month, so a
 * persona seeded in January dresses for January.
 *
 * The same days also exist as the app's forecasts (forecastDayOf: hour by
 * hour in °C, what src/web/weather/open-meteo.ts makes of Open-Meteo's
 * answer), which is what the tests' stand-in for Open-Meteo serves
 * (test/support/weather-stub.ts): the demo's calendar shows the weather its
 * planned week was drawn for, and weather.spec.ts holds the bands to the
 * matching's targets (src/weather/match.ts).
 */

/** Feels-like bands, hottest first; outfits list the bands they suit. */
export const BANDS = [
  'hot',
  'warm',
  'mild',
  'cool',
  'cold',
  'freezing',
] as const;
export type Band = (typeof BANDS)[number];

export interface Weather {
  day: IsoDate;
  /** Feels-like high, °F, rounded. */
  high: number;
  /** Air temperature high, °F (the feels-like without the humidity). */
  airHigh: number;
  band: Band;
  rain: boolean;
}

// Jan..Dec, °F: Central Park normal highs (NOAA 1991-2020).
const NORMAL_HIGH = [39, 42, 50, 62, 72, 80, 84, 83, 76, 64, 54, 44];
// Jan..Dec: days with at least 0.1 in of rain over the month's days.
const RAIN_ODDS = [
  0.35, 0.33, 0.36, 0.37, 0.36, 0.33, 0.3, 0.28, 0.25, 0.28, 0.3, 0.34,
];
const PERSISTENCE = 0.6;
const ANOMALY_SD = 5;
// Humid days feel hotter: up to this much above 80 °F.
const HUMIDITY_MAX = 6;
// Days of the AR(1) walk behind each day's anomaly: 0.6^14 is under 0.1 %,
// so the truncation is invisible.
const MEMORY_DAYS = 14;

export function bandOf(high: number): Band {
  if (high >= 85) return 'hot';
  if (high >= 75) return 'warm';
  if (high >= 65) return 'mild';
  if (high >= 52) return 'cool';
  if (high >= 38) return 'cold';
  return 'freezing';
}

/**
 * The normal high on `day`, linear between the 15th of each month (the
 * table's value) and the next.
 */
export function normalHigh(day: IsoDate): number {
  const { year, month, day: date } = dateParts(day);
  const previous = addMonths({ year, month }, -1);
  const [from, to, fraction] =
    date >= 15
      ? [month - 1, month % 12, (date - 15) / daysInMonth({ year, month })]
      : [
          previous.month - 1,
          month - 1,
          (date + daysInMonth(previous) - 15) / daysInMonth(previous),
        ];
  return NORMAL_HIGH[from] + (NORMAL_HIGH[to] - NORMAL_HIGH[from]) * fraction;
}

/**
 * Each day's weather from `first` for `count` days, for `key` (the
 * persona). `shift` adds °F to a day (a heat wave). A day's weather depends
 * on its date alone, whatever window it is part of: its anomaly is the walk
 * over the MEMORY_DAYS before it, each day's step drawn from that day's own
 * stream.
 */
export function weatherFor(
  key: string,
  first: IsoDate,
  count: number,
  shift: (day: IsoDate) => number = () => 0,
): Weather[] {
  return Array.from({ length: count }, (_, offset) => {
    const day = addDays(first, offset);
    const air = normalHigh(day) + anomalyOn(key, day) + shift(day);
    const humid = Math.min(HUMIDITY_MAX, Math.max(0, (air - 80) * 0.6));
    const high = Math.round(air + humid);
    const { month } = dateParts(day);
    return {
      day,
      high,
      airHigh: Math.round(air),
      band: bandOf(high),
      rain: stream(key, 'rain', day).chance(RAIN_ODDS[month - 1]),
    };
  });
}

function anomalyOn(key: string, day: IsoDate): number {
  const step = Math.sqrt(1 - PERSISTENCE ** 2) * ANOMALY_SD;
  let anomaly = 0;
  for (let back = MEMORY_DAYS; back >= 0; back -= 1) {
    const random = stream(key, 'weather', addDays(day, -back));
    anomaly = PERSISTENCE * anomaly + step * random.gaussian();
  }
  return anomaly;
}

// A day's feels-like runs from its low at LOW_HOUR to its high at HIGH_HOUR
// and back: the shape of a clear day. The swing is 12 to 18 °F (Central
// Park's normal daily range).
const LOW_HOUR = 6;
const HIGH_HOUR = 15;
const SWING_F = { min: 12, max: 18 };
// A rainy day's rain: a spell of 3 to 8 hours starting between 6:00 and
// 18:00, likely (70-90 %) inside it and unlikely (10-25 %) outside.
const RAIN_SPELL = { firstStart: 6, lastStart: 18, min: 3, max: 8 };
// WMO codes (src/weather/forecast.ts, conditionOf).
const CODE = { clear: 0, partly: 2, overcast: 3, rain: 63, snow: 73 };

/**
 * A simulated day as a forecast (°C, hour by hour in the household's zone),
 * for `key` (the persona): what the tests' Open-Meteo stand-in answers.
 * Deterministic, from the day's own streams.
 */
export function forecastDayOf(key: string, weather: Weather): DayForecast {
  const random = stream(key, 'forecast', weather.day);
  const swing = SWING_F.min + (SWING_F.max - SWING_F.min) * random.next();
  const feelsHigh = weather.high;
  const feelsLow = feelsHigh - swing;
  const spellStart =
    RAIN_SPELL.firstStart +
    Math.floor(
      random.next() * (RAIN_SPELL.lastStart - RAIN_SPELL.firstStart + 1),
    );
  const spellEnd =
    spellStart +
    RAIN_SPELL.min +
    Math.floor(random.next() * (RAIN_SPELL.max - RAIN_SPELL.min + 1));
  const sky = random.next();
  const dryCode =
    sky < 0.4 ? CODE.clear : sky < 0.75 ? CODE.partly : CODE.overcast;
  const wetCode = fahrenheitToCelsius(feelsHigh) < 1 ? CODE.snow : CODE.rain;
  const hours: HourForecast[] = Array.from({ length: 24 }, (_, hour) => {
    const raining = weather.rain && hour >= spellStart && hour < spellEnd;
    const chance = raining
      ? 70 + Math.floor(random.next() * 21)
      : 10 + Math.floor(random.next() * (weather.rain ? 16 : 6));
    return {
      hour,
      feelsLike: round1(fahrenheitToCelsius(feelsLow + swing * diurnal(hour))),
      precipitationChance: chance,
      code: raining ? wetCode : dryCode,
    };
  });
  return {
    day: weather.day,
    code: weather.rain ? wetCode : dryCode,
    high: round1(fahrenheitToCelsius(weather.airHigh)),
    low: round1(fahrenheitToCelsius(weather.airHigh - swing)),
    precipitationChance: Math.max(...hours.map((h) => h.precipitationChance)),
    hours,
  };
}

/** 0 at LOW_HOUR, 1 at HIGH_HOUR, a cosine between and back overnight. */
function diurnal(hour: number): number {
  if (hour >= LOW_HOUR && hour <= HIGH_HOUR) {
    return (
      (1 - Math.cos((Math.PI * (hour - LOW_HOUR)) / (HIGH_HOUR - LOW_HOUR))) / 2
    );
  }
  const since = (hour + 24 - HIGH_HOUR) % 24;
  return (1 + Math.cos((Math.PI * since) / (24 - HIGH_HOUR + LOW_HOUR))) / 2;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
