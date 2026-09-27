import type { IsoDate } from '../calendar/calendar-date';
import {
  type Condition,
  conditionOf,
  forecastDay,
  rainFrom,
} from '../../weather/forecast';
import { weatherNeeds } from '../../weather/match';
import {
  displayTemperature,
  type TemperatureUnit,
} from '../../weather/temperature';
import type { ActiveLocation, WeatherSettings } from './queries';
import type { CachedForecast } from './service';

/**
 * What the weather views show, computed from a cached forecast (pure;
 * summary.spec.ts): today's line for the page headers and a chip per
 * calendar day (docs/plans/2026-09-26-redesign.md, section 5: one
 * WeatherLine, one WeatherDay, reused by the redesign's headers, the
 * calendar agenda and Today).
 */

export interface TodayLine {
  condition: Condition;
  /** Air temperature, in the user's unit. */
  high: number;
  low: number;
  unit: TemperatureUnit;
  /** The first hour still to come today with rain likely, or null. */
  rainFrom: number | null;
  /** It is raining (likely) this hour. */
  rainNow: boolean;
  /** The day's swing asks for a layer (the matching's all-day rule). */
  layer: boolean;
  /** The home's short name; null for the phone's location. */
  place: string | null;
  fetchedAt: Date;
}

export interface DayChip {
  day: IsoDate;
  condition: Condition;
  high: number;
  low: number;
}

export function todayLine(input: {
  cached: CachedForecast;
  active: ActiveLocation;
  settings: WeatherSettings;
  /** Today and the hour now, in APP_TIMEZONE (todayIn, hourIn). */
  today: IsoDate;
  hour: number;
}): TodayLine | null {
  const { cached, active, settings, today, hour } = input;
  const day = forecastDay(cached.forecast, today);
  if (!day) return null;
  const rain = rainFrom(day, hour);
  return {
    condition: conditionOf(day.code),
    high: displayTemperature(day.high, settings.unit),
    low: displayTemperature(day.low, settings.unit),
    unit: settings.unit,
    rainFrom: rain !== null && rain > hour ? rain : null,
    rainNow: rain === hour,
    layer: weatherNeeds(day, 'all-day', settings.offset)?.layer ?? false,
    place: active.name ? shortPlace(active.name) : null,
    fetchedAt: cached.fetchedAt,
  };
}

/** The forecast's chips for `days` it covers; days past it get none. */
export function dayChips(
  cached: CachedForecast,
  days: readonly IsoDate[],
  unit: TemperatureUnit,
): DayChip[] {
  return days.flatMap((date) => {
    const day = forecastDay(cached.forecast, date);
    return day
      ? [
          {
            day: date,
            condition: conditionOf(day.code),
            high: displayTemperature(day.high, unit),
            low: displayTemperature(day.low, unit),
          },
        ]
      : [];
  });
}

/** "Brooklyn, New York, United States" is "Brooklyn" in a header. */
export function shortPlace(name: string): string {
  return name.split(',')[0].trim();
}
