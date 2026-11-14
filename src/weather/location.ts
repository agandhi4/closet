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

/**
 * A location with the IANA zone its weather is asked and kept in (#678):
 * APP_TIMEZONE for the home and the phone's location, the destination's own
 * for a trip, so a trip day is a civil date there and an occasion's hours
 * are its hours. The weather caches' key: one cell asked in two zones is two
 * answers (their days and hours differ).
 */
export interface ZonedLocation extends Location {
  /** Canonical (canonicalTimeZone, src/calendar-date.ts). */
  timeZone: string;
}

/**
 * A place picked from the geocoding search (a trip's destination): its
 * location and the zone the answer named, null when it named none Intl
 * knows or the place was picked before #678.
 */
export interface PickedLocation extends Location {
  timeZone: string | null;
}

/**
 * The place in its own zone, or in `fallback` (APP_TIMEZONE) while it has
 * none: a trip located before #678, or one whose geocoding answer named no
 * zone Intl knows.
 */
export function zonedIn(
  place: Location & { timeZone?: string | null },
  fallback: string,
): ZonedLocation {
  return {
    latitude: place.latitude,
    longitude: place.longitude,
    timeZone: place.timeZone ?? fallback,
  };
}

/** `35.68,139.69 Asia/Tokyo`: the cache's key and its log lines' place. */
export function zonedLabel(place: ZonedLocation): string {
  return `${locationLabel(place)} ${place.timeZone}`;
}
