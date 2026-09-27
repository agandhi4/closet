/**
 * Where the weather is for (#14; plan section 7). Coordinates are only ever
 * kept and sent rounded to COORDINATE_DECIMALS: two decimals is about 1.1 km
 * of latitude, a neighbourhood, never an address. Every coordinate that
 * enters the app (a city picked from the geocoding search, the phone's
 * position) goes through roundedLocation() before it is stored, used as the
 * forecast cache's key or put in a request to Open-Meteo. Pure.
 */

export const COORDINATE_DECIMALS = 2;

export interface Location {
  /** Degrees north, -90 to 90, rounded. */
  latitude: number;
  /** Degrees east, -180 to 180, rounded. */
  longitude: number;
}

const SCALE = 10 ** COORDINATE_DECIMALS;

/** A coordinate to COORDINATE_DECIMALS places (half away from zero; never -0). */
export function roundCoordinate(value: number): number {
  const rounded =
    (Math.sign(value) * Math.round(Math.abs(value) * SCALE)) / SCALE;
  return rounded === 0 ? 0 : rounded;
}

/** The location as it may be stored and sent, or null outside the globe. */
export function roundedLocation(
  latitude: number,
  longitude: number,
): Location | null {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return {
    latitude: roundCoordinate(latitude),
    longitude: roundCoordinate(longitude),
  };
}

/** `40.69,-73.97`: the rounded location as the logs and the cache name it. */
export function locationLabel({ latitude, longitude }: Location): string {
  return `${latitude.toFixed(COORDINATE_DECIMALS)},${longitude.toFixed(COORDINATE_DECIMALS)}`;
}
