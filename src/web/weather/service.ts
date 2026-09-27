import type { Db } from '../../db/client';
import type { Logger } from '../../logger';
import type { Forecast } from '../../weather/forecast';
import type { Location } from '../../weather/location';
import { type ClimateNormals, normalYears } from '../../weather/normals';
import { todayIn } from '../calendar/calendar-date';
import { createLocationCache, elapsed, failureReason } from './location-cache';
import type { Place, WeatherClient } from './open-meteo';
import {
  type ActiveLocation,
  activeLocation,
  findForecastRow,
  findNormalsRow,
  findWeatherSettings,
  recordFailedForecast,
  recordFailedNormals,
  saveForecast,
  saveNormals,
  type WeatherSettings,
} from './queries';

/**
 * The weather as the app asks for it (#14): a location's forecast from the
 * cache table (weather_forecast), refreshed from Open-Meteo once it is
 * FRESH_FOR_MS old, and its climate normals (weather_normals, for #10's
 * trips' days past the forecast) once they are NORMALS_FRESH_FOR_MS old;
 * both through createLocationCache (location-cache.ts: one lookup per
 * location at a time, the last good answer kept, RETRY_AFTER_MS between
 * failed tries). Nothing runs in the background: a page (its weather
 * fragment), the MCP tools or the seed ask, and the asking request waits
 * for at most one fetch (the fetcher's 10 s bound). Built once by
 * createApp() when WEATHER_ENABLED, never otherwise, so with the flag off
 * nothing can fetch.
 *
 * Logs (context Weather) name the rounded location (`40.69,-73.97`), never
 * the user; the fetcher's own line names only the host.
 */

/** A forecast is refreshed once it is this old: once an hour per location. */
export const FRESH_FOR_MS = 60 * 60 * 1000;
/**
 * Normals are refreshed once they are this old. Their years change only on
 * New Year (normalYears) and the archive's newest days settle over weeks,
 * so a month is fresh enough and keeps a place to one archive request a
 * month.
 */
export const NORMALS_FRESH_FOR_MS = 30 * 24 * 60 * 60 * 1000;
/** After a failed refresh, the pause before the next try. */
export const RETRY_AFTER_MS = 10 * 60 * 1000;

export interface CachedForecast {
  forecast: Forecast;
  /** When the answer was fetched: the "as of" the pages show. */
  fetchedAt: Date;
}

export interface CachedNormals {
  normals: ClimateNormals;
  fetchedAt: Date;
}

export interface WeatherService {
  /** The location's forecast, fresh when Open-Meteo answers; null if it never has. */
  forecastFor(location: Location): Promise<CachedForecast | null>;
  /**
   * The location's climate normals, null if Open-Meteo never answered. For
   * a trip's days past the forecast only: Today, the calendar and the
   * weekly plan stay forecast-only (src/weather/normals.ts).
   */
  normalsFor(location: Location): Promise<CachedNormals | null>;
  searchPlaces(query: string): Promise<Place[]>;
}

/** A user's weather: settings, where it is for, and its forecast. */
export interface UserWeather {
  settings: WeatherSettings;
  active: ActiveLocation | null;
  cached: CachedForecast | null;
}

export function createWeatherService(options: {
  db: Db;
  client: WeatherClient;
  logger: Logger;
  /** APP_TIMEZONE: which year it is, for the normals' years. */
  timeZone: string;
  /** The clock; specs pin it. */
  now?: () => Date;
}): WeatherService {
  const { db, client, logger, timeZone, now = () => new Date() } = options;

  const forecasts = createLocationCache<Forecast>({
    name: 'Forecast',
    freshForMs: FRESH_FOR_MS,
    retryAfterMs: RETRY_AFTER_MS,
    now,
    logger,
    read: (location) => findForecastRow(db, location),
    save: (location, forecast, at) => saveForecast(db, location, forecast, at),
    recordFailure: (location, at) => recordFailedForecast(db, location, at),
    fetch: (location) => client.forecast(location),
    describe: (forecast) => `${forecast.days.length} days`,
  });

  const normals = createLocationCache<ClimateNormals>({
    name: 'Climate normals',
    freshForMs: NORMALS_FRESH_FOR_MS,
    retryAfterMs: RETRY_AFTER_MS,
    now,
    logger,
    read: (location) => findNormalsRow(db, location),
    save: (location, value, at) => saveNormals(db, location, value, at),
    recordFailure: (location, at) => recordFailedNormals(db, location, at),
    fetch: (location) =>
      client.normals(location, normalYears(todayIn(timeZone, now()))),
    describe: ({ days, years }) =>
      `${Object.keys(days).length} days from ${years.first}-${years.last}`,
  });

  return {
    async forecastFor(location) {
      const cached = await forecasts(location);
      return cached && { forecast: cached.value, fetchedAt: cached.fetchedAt };
    },

    async normalsFor(location) {
      const cached = await normals(location);
      return cached && { normals: cached.value, fetchedAt: cached.fetchedAt };
    },

    async searchPlaces(query) {
      const started = performance.now();
      try {
        const places = await client.searchPlaces(query);
        // Never the query: a typed city says where someone lives.
        logger.info(
          `Place search: ${places.length} result(s) in ${elapsed(started)} ms`,
        );
        return places;
      } catch (error) {
        logger.warn(
          `Place search failed (${failureReason(error)}) after ${elapsed(started)} ms`,
        );
        throw error;
      }
    },
  };
}

/** The user's settings, where their weather is for now, and its forecast. */
export async function userWeather(
  db: Db,
  weather: WeatherService,
  userId: number,
  now: Date,
): Promise<UserWeather> {
  const settings = await findWeatherSettings(db, userId);
  const active = activeLocation(settings, now);
  const cached = active ? await weather.forecastFor(active.location) : null;
  return { settings, active, cached };
}
