/**
 * Body measurements (#24; plan section 16), the weather's temperature
 * pattern (src/weather/temperature.ts): every length is stored in
 * centimetres, and the unit is only how a person reads and types them.
 * Pure.
 */

/** In the order a tailor takes them, top to toe; the Profile lists them so. */
export const MEASUREMENTS = [
  'height',
  'neck',
  'shoulders',
  'chest',
  'sleeve',
  'waist',
  'hips',
  'inseam',
] as const;
export type Measurement = (typeof MEASUREMENTS)[number];

export const LENGTH_UNITS = ['in', 'cm'] as const;
export type LengthUnit = (typeof LENGTH_UNITS)[number];

/** A user who never chose: inches, for the NYC household. The migration's column default must match (drizzle/0026_sizes.sql). */
export const DEFAULT_LENGTH_UNIT: LengthUnit = 'in';

/** What a stored length may be, in cm: the columns' check constraint says the same. */
export const LENGTH_MIN_CM = 1;
export const LENGTH_MAX_CM = 300;

const CM_PER_INCH = 2.54;

/**
 * Decimals a length is shown with: two for inches, so quarter inches come
 * back as typed through the stored cm (32.25 in is 81.92 cm, 32.2520 in),
 * one for centimetres.
 */
const SHOWN_DECIMALS: Record<LengthUnit, number> = { in: 2, cm: 1 };

/** Decimals the columns keep (numeric(5, 2)). */
const STORED_DECIMALS = 2;

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** A length typed in `unit` as it is stored: cm, to the column's two decimals. */
export function toCentimetres(value: number, unit: LengthUnit): number {
  const cm = unit === 'in' ? value * CM_PER_INCH : value;
  return round(cm, STORED_DECIMALS);
}

/** A stored length in `unit`, rounded as it is shown. */
export function inUnit(cm: number, unit: LengthUnit): number {
  const value = unit === 'in' ? cm / CM_PER_INCH : cm;
  return round(value, SHOWN_DECIMALS[unit]);
}

/** A stored length as the form shows it: `32.25`, `81.9`, no trailing zeros. */
export function lengthText(cm: number, unit: LengthUnit): string {
  return String(inUnit(cm, unit));
}

/** Every measurement, each null until set. */
export type Measurements = Record<Measurement, number | null>;

export const NO_MEASUREMENTS: Measurements = Object.fromEntries(
  MEASUREMENTS.map((m) => [m, null]),
) as Measurements;
