import {
  addDays,
  addMonths,
  dateParts,
  daysInMonth,
  type IsoDate,
} from '../web/calendar/calendar-date';
import { stream } from './random';

/**
 * A plausible New York day for the seed's simulated history: pure, no
 * network (#14 brings real forecasts, for today only). Central Park's
 * 1991-2020 normal highs, interpolated between month mid-points, plus an
 * AR(1) anomaly so warm and cool spells last a few days, humidity on hot
 * days, and rain by the month's odds. The personas' outfits are chosen by
 * the day's band (demo.md, Simulation), not by month, so a persona seeded in
 * January dresses for January.
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
