/**
 * Temperatures and the personal offset (#14; plan section 7). Everything the
 * app computes is in °C, as Open-Meteo answers; the unit is only how a user
 * reads it. Pure.
 */

export const TEMPERATURE_UNITS = ['celsius', 'fahrenheit'] as const;
export type TemperatureUnit = (typeof TEMPERATURE_UNITS)[number];

/** A user who never chose: °F, for the NYC household (owner, 2026-09-26). The migration's column default must match (drizzle/0015_weather.sql). */
export const DEFAULT_TEMPERATURE_UNIT: TemperatureUnit = 'fahrenheit';

export function isTemperatureUnit(value: string): value is TemperatureUnit {
  return (TEMPERATURE_UNITS as readonly string[]).includes(value);
}

/** A temperature in °C as the user reads it, rounded to a whole degree. */
export function displayTemperature(
  celsius: number,
  unit: TemperatureUnit,
): number {
  const value = unit === 'fahrenheit' ? (celsius * 9) / 5 + 32 : celsius;
  const rounded = Math.round(value);
  return rounded === 0 ? 0 : rounded;
}

/** A difference of °C (the offset) in the user's unit, to one decimal. */
export function displayDifference(
  celsius: number,
  unit: TemperatureUnit,
): number {
  const value = unit === 'fahrenheit' ? (celsius * 9) / 5 : celsius;
  const rounded = Math.round(value * 10) / 10;
  return rounded === 0 ? 0 : rounded;
}

export function fahrenheitToCelsius(fahrenheit: number): number {
  return ((fahrenheit - 32) * 5) / 9;
}

/**
 * The personal temperature offset (Acloset's idea): °C added to the
 * feels-like temperature before matching (src/weather/match.ts). Positive
 * for someone who runs warm (they dress lighter), negative for someone who
 * runs cold. Kept within ±OFFSET_LIMIT; the column's check constraint says
 * the same.
 */
export const OFFSET_LIMIT = 5;
/** One "too warm" or "too cold" moves it this far. */
export const OFFSET_STEP = 0.5;

/** How an outfit felt: the feedback that nudges the offset. */
export const FEELINGS = ['too-warm', 'too-cold'] as const;
export type Feeling = (typeof FEELINGS)[number];

/**
 * The offset after one piece of feedback. Too warm means the user feels the
 * weather warmer than it reads, so the offset rises (lighter outfits next
 * time); too cold lowers it. Capped at ±OFFSET_LIMIT.
 */
export function nudgeOffset(offset: number, feeling: Feeling): number {
  const step = feeling === 'too-warm' ? OFFSET_STEP : -OFFSET_STEP;
  return clampOffset(offset + step);
}

/** Within ±OFFSET_LIMIT, on the OFFSET_STEP grid the column stores. */
export function clampOffset(offset: number): number {
  const stepped = Math.round(offset / OFFSET_STEP) * OFFSET_STEP;
  const clamped = Math.min(OFFSET_LIMIT, Math.max(-OFFSET_LIMIT, stepped));
  return clamped === 0 ? 0 : clamped;
}
