import type { Db } from '../../db/client';
import type { Logger } from '../../logger';
import type { Forecast } from '../../weather/forecast';
import { type Location, locationLabel } from '../../weather/location';
import { type ClimateNormals, normalYears } from '../../weather/normals';
import { todayIn } from '../calendar/calendar-date';
import {
  createLocationCache,
  elapsed,
  failureReason,
  type ReadOptions,
} from './location-cache';
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
 * both through createLocationCache (location-cache.ts: a stale answer
 * served at once and refreshed in the background, one refresh per location
 * at a time, the last good answer kept, RETRY_AFTER_MS between failed
 * tries). A page (its weather fragment, Today, Ideas), the MCP tools or the
 * seed ask; only an ask with nothing cached waits, for at most one fetch
 * (the fetcher's 10 s bound), or a job's one-shot decision reading with
 * `{ fresh: true }` (the week's plan and re-plan, the morning reminder),
 * which waits for a stale answer's refresh. Built once by
 * createApp() when WEATHER_ENABLED, never otherwise, so with the flag off
 * nothing can fetch.
 *
 * Logs (context Weather) name the rounded location (`40.69,-73.97`), never
 * the user; the fetcher's own line names only the host.
 */

/**
 * A batch job's forecast refresh (refreshForecastsFor): how many locations
 * are fetched at once, and the one deadline over all of them. The deadline
 * is a little over one fetch's bound (the fetcher's 10 s), so a minute's
 * run never waits much longer than one slow Open-Meteo answer.
 */
export const BATCH_REFRESH_CONCURRENCY = 4;
export const BATCH_REFRESH_DEADLINE_MS = 12_000;

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
  /**
   * The location's cached forecast (refreshed in the background once
   * stale), fetched while the ask waits only when none is cached; null if
   * Open-Meteo never answered.
   */
  forecastFor(
    location: Location,
    read?: ReadOptions,
  ): Promise<CachedForecast | null>;
  /**
   * The location's climate normals, null if Open-Meteo never answered. For
   * a trip's days past the forecast only: Today, the calendar and the
   * weekly plan stay forecast-only (src/weather/normals.ts).
   */
  normalsFor(location: Location): Promise<CachedNormals | null>;
  searchPlaces(query: string): Promise<Place[]>;
  /**
   * Resolves once no background refresh is running: the app's close awaits
   * it before ending the pool.
   */
  settled(): Promise<void>;
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

  const currentYears = () => normalYears(todayIn(timeZone, now()));

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
    // Its days and hours are the zone's it was requested in: after an
    // APP_TIMEZONE change they are another household's days.
    mismatch: (forecast) =>
      forecast.timeZone === timeZone
        ? null
        : `for ${forecast.timeZone}, not ${timeZone}`,
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
    fetch: (location) => client.normals(location, currentYears()),
    describe: ({ days, years }) =>
      `${Object.keys(days).length} days from ${years.first}-${years.last}`,
    // The years move on New Year: January's normals are 2017-2026, not the
    // December row's 2016-2025, however young that row is.
    mismatch: ({ years }) => {
      const wanted = currentYears();
      return years.first === wanted.first && years.last === wanted.last
        ? null
        : `of ${years.first}-${years.last}, not ${wanted.first}-${wanted.last}`;
    },
  });

  return {
    async forecastFor(location, read) {
      const cached = await forecasts.get(location, read);
      return cached && { forecast: cached.value, fetchedAt: cached.fetchedAt };
    },

    async normalsFor(location) {
      const cached = await normals.get(location);
      return cached && { normals: cached.value, fetchedAt: cached.fetchedAt };
    },

    async settled() {
      await Promise.all([forecasts.settled(), normals.settled()]);
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
  /** `{ fresh: true }` for a job's one-shot decision (location-cache.ts). */
  read?: ReadOptions,
): Promise<UserWeather> {
  const settings = await findWeatherSettings(db, userId);
  const active = activeLocation(settings, now);
  const cached = active
    ? await weather.forecastFor(active.location, read)
    : null;
  return { settings, active, cached };
}

/**
 * Refreshes, together, the forecasts a batch job is about to decide on:
 * the distinct active locations of `userIds`, each through the cache's
 * fresh read (its single flight), BATCH_REFRESH_CONCURRENCY at a time,
 * within BATCH_REFRESH_DEADLINE_MS in all. The job then reads each person's
 * forecast without `fresh` (a refreshed row, or the stale one where the
 * refresh failed or overran), so N people at N places cost about one fetch,
 * not N one after another: the minutely timers skip a minute a slow run
 * overran. Used by the morning reminders and the daily re-plan. Never
 * throws: a location that fails is logged and left to its stale row.
 */
export async function refreshForecastsFor(
  deps: { db: Db; weather: WeatherService; logger: Logger },
  userIds: readonly number[],
  now: Date,
): Promise<void> {
  const locations = new Map<string, Location>();
  for (const userId of new Set(userIds)) {
    const active = activeLocation(
      await findWeatherSettings(deps.db, userId),
      now,
    );
    if (active) locations.set(locationLabel(active.location), active.location);
  }
  if (locations.size === 0) return;
  const started = performance.now();
  const queue = [...locations.values()];
  let expired = false;
  let pending = queue.length;
  const worker = async () => {
    // No new fetch once the deadline has passed: the job reads stale rows.
    while (!expired) {
      const location = queue.shift();
      if (!location) return;
      await deps.weather
        .forecastFor(location, { fresh: true })
        .catch((error: unknown) =>
          deps.logger.error(
            { err: error },
            `Forecast refresh for ${locationLabel(location)} failed`,
          ),
        );
      pending -= 1;
    }
  };
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.all(
      Array.from(
        { length: Math.min(BATCH_REFRESH_CONCURRENCY, queue.length) },
        worker,
      ),
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, BATCH_REFRESH_DEADLINE_MS);
    }),
  ]);
  clearTimeout(timer);
  expired = true;
  deps.logger.info(
    `Forecasts for ${locations.size} location(s) refreshed for a batch in ${elapsed(started)} ms${
      pending > 0 ? `; ${pending} not done by the deadline, read stale` : ''
    }`,
  );
}
