import type { Db } from '../../db/client';
import type { Logger } from '../../logger';
import type { Forecast } from '../../weather/forecast';
import { type Location, locationLabel } from '../../weather/location';
import { OutboundFetchError } from '../security/outbound-fetch';
import type { Place, WeatherClient } from './open-meteo';
import {
  type ActiveLocation,
  activeLocation,
  findForecastRow,
  findWeatherSettings,
  type ForecastRow,
  recordFailedFetch,
  saveForecast,
  type WeatherSettings,
} from './queries';

/**
 * The weather as the app asks for it (#14): a location's forecast from the
 * cache table (weather_forecast), refreshed from Open-Meteo once it is
 * FRESH_FOR_MS old, one refresh per location at a time in this process, and
 * the last good answer served when a refresh fails. Nothing runs in the
 * background: a page (its weather fragment), the MCP tools or the seed ask,
 * and the asking request waits for at most one fetch (the fetcher's 10 s
 * bound). Built once by createApp() when WEATHER_ENABLED, never otherwise,
 * so with the flag off nothing can fetch.
 *
 * Logs (context Weather) name the rounded location (`40.69,-73.97`), never
 * the user; the fetcher's own line names only the host.
 */

/** A forecast is refreshed once it is this old: once an hour per location. */
export const FRESH_FOR_MS = 60 * 60 * 1000;
/** After a failed refresh, the pause before the next try. */
export const RETRY_AFTER_MS = 10 * 60 * 1000;

export interface CachedForecast {
  forecast: Forecast;
  /** When the answer was fetched: the "as of" the pages show. */
  fetchedAt: Date;
}

export interface WeatherService {
  /** The location's forecast, fresh when Open-Meteo answers; null if it never has. */
  forecastFor(location: Location): Promise<CachedForecast | null>;
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
  /** The clock; specs pin it. */
  now?: () => Date;
}): WeatherService {
  const { db, client, logger, now = () => new Date() } = options;
  // One lookup per location at a time, the cache read included: the pages
  // of one household ask for the same place together (the wardrobe and
  // calendar fragments, a second phone), and an ask that read the stale row
  // just before another's refresh saved would refresh again. Across
  // processes a duplicate fetch is harmless.
  const inFlight = new Map<string, Promise<CachedForecast | null>>();

  async function lookup(location: Location): Promise<CachedForecast | null> {
    const row = await findForecastRow(db, location);
    const at = now().getTime();
    const kept = lastGood(row);
    if (kept && at - kept.fetchedAt.getTime() < FRESH_FOR_MS) return kept;
    // A refresh failed a moment ago: do not ask again yet.
    if (
      row &&
      at - row.attemptedAt.getTime() < RETRY_AFTER_MS &&
      row.attemptedAt.getTime() !== row.fetchedAt?.getTime()
    ) {
      return kept;
    }
    return refresh(location, row);
  }

  async function refresh(
    location: Location,
    row: ForecastRow | undefined,
  ): Promise<CachedForecast | null> {
    const label = locationLabel(location);
    const started = performance.now();
    try {
      const forecast = await client.forecast(location);
      const fetchedAt = now();
      await saveForecast(db, location, forecast, fetchedAt);
      logger.info(
        `Forecast for ${label}: ${forecast.days.length} days in ${elapsed(started)} ms`,
      );
      return { forecast, fetchedAt };
    } catch (error) {
      await recordFailedFetch(db, location, now());
      const kept = lastGood(row);
      logger.warn(
        `Forecast for ${label} failed (${reason(error)}) after ${elapsed(started)} ms; ${
          kept
            ? `serving the one from ${kept.fetchedAt.toISOString()}`
            : 'none to serve'
        }`,
      );
      return kept;
    }
  }

  return {
    forecastFor(location) {
      const key = locationLabel(location);
      const running = inFlight.get(key);
      if (running) return running;
      const looking = lookup(location).finally(() => inFlight.delete(key));
      inFlight.set(key, looking);
      return looking;
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
          `Place search failed (${reason(error)}) after ${elapsed(started)} ms`,
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

function lastGood(row: ForecastRow | undefined): CachedForecast | null {
  return row?.forecast && row.fetchedAt
    ? { forecast: row.forecast, fetchedAt: row.fetchedAt }
    : null;
}

/** The refusal's rule or the error's name, for the log; never a URL. */
function reason(error: unknown): string {
  if (error instanceof OutboundFetchError) return error.reason;
  return error instanceof Error ? error.name : 'unknown';
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}
