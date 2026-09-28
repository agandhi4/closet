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
  type KnownRow,
  type ReadOptions,
} from './location-cache';
import type { Place, WeatherClient } from './open-meteo';
import {
  type ActiveLocation,
  activeLocation,
  findForecastRow,
  findNormalsRow,
  findWeathersWithForecast,
  findWeatherWithForecast,
  NO_WEATHER_SETTINGS,
  recordFailedForecast,
  recordFailedNormals,
  saveForecast,
  saveNormals,
  type WeatherSettings,
  type WeatherWithForecast,
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
    /** The row userWeather read with the settings (LocationCache.get). */
    known?: KnownRow<Forecast>,
  ): Promise<CachedForecast | null>;
  /**
   * The location's climate normals, null if Open-Meteo never answered. For
   * a trip's days past the forecast only: Today, the calendar and the
   * weekly plan stay forecast-only (src/weather/normals.ts).
   */
  normalsFor(
    location: Location,
    /** The row the caller read in a statement of its own (tripForecast). */
    known?: KnownRow<ClimateNormals>,
  ): Promise<CachedNormals | null>;
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
    async forecastFor(location, read, known) {
      const cached = await forecasts.get(location, read, known);
      return cached && { forecast: cached.value, fetchedAt: cached.fetchedAt };
    },

    async normalsFor(location, known) {
      const cached = await normals.get(location, undefined, known);
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

/**
 * The user's settings, where their weather is for now, and its forecast.
 * One statement reads the settings and that location's cache row together
 * (findWeatherWithForecast), which the cache decides from rather than
 * reading the row again (#158: every weather line, Today and its ideas
 * paid two round trips here).
 */
export async function userWeather(
  db: Db,
  weather: WeatherService,
  userId: number,
  now: Date,
  /** `{ fresh: true }` for a job's one-shot decision (location-cache.ts). */
  read?: ReadOptions,
): Promise<UserWeather> {
  const found = await findWeatherWithForecast(db, userId, now);
  return userWeatherFrom(weather, found, now, read);
}

/**
 * userWeather from settings and a cache row already read, in a statement
 * of the caller's (weatherWithForecastSql in the outfit gallery's ideasFor,
 * #168). Reads the database again only when the row says the forecast
 * must be fetched.
 */
export async function userWeatherFrom(
  weather: WeatherService,
  { settings, forecast }: WeatherWithForecast,
  now: Date,
  read?: ReadOptions,
): Promise<UserWeather> {
  const active = activeLocation(settings, now);
  const cached = active
    ? await weather.forecastFor(active.location, read, forecast ?? undefined)
    : null;
  return { settings, active, cached };
}

/**
 * Refreshes, together, the forecasts a batch job is about to decide on:
 * the distinct active locations of `userIds`, each through the cache's
 * fresh read (its single flight), BATCH_REFRESH_CONCURRENCY at a time,
 * within BATCH_REFRESH_DEADLINE_MS in all, so N people at N places cost
 * about one fetch, not N one after another: the minutely timers skip a
 * minute a slow run overran. Used by the morning reminders and the daily
 * re-plan.
 *
 * Answers each user's weather as userWeather would now (the refreshed
 * answer, or the stale one where the refresh failed or overran the
 * deadline), so a job need not read it again per person: the daily
 * re-plan decides from it. Every user's settings and row come from one
 * statement (findWeathersWithForecast; a read per user was an N+1, #165),
 * handed to the cache as `known`. A location that fails never throws: it
 * is logged and its users left out of the answer, for the job to read as
 * it would without the batch.
 */
export async function refreshForecastsFor(
  deps: { db: Db; weather: WeatherService; logger: Logger },
  userIds: readonly number[],
  now: Date,
): Promise<Map<number, UserWeather>> {
  const users = new Map<number, UserWeather>();
  const found = await findWeathersWithForecast(deps.db, userIds, now);
  const locations = new Map<
    string,
    { location: Location; known: KnownRow<Forecast> | undefined }
  >();
  const actives = new Map<number, ActiveLocation>();
  for (const userId of new Set(userIds)) {
    const { settings, forecast } = found.get(userId) ?? {
      settings: NO_WEATHER_SETTINGS,
      forecast: null,
    };
    const active = activeLocation(settings, now);
    if (!active) {
      users.set(userId, { settings, active: null, cached: null });
      continue;
    }
    actives.set(userId, active);
    const label = locationLabel(active.location);
    if (!locations.has(label)) {
      locations.set(label, {
        location: active.location,
        known: forecast ?? undefined,
      });
    }
  }
  if (locations.size === 0) return users;
  const started = performance.now();
  const answers = new Map<string, CachedForecast | null>();
  const queue = [...locations.entries()];
  let expired = false;
  let pending = queue.length;
  const worker = async () => {
    // No new fetch once the deadline has passed: the job reads stale rows.
    while (!expired) {
      const next = queue.shift();
      if (!next) return;
      const [label, { location, known }] = next;
      await deps.weather
        .forecastFor(location, { fresh: true }, known)
        .then((cached) => answers.set(label, cached))
        .catch((error: unknown) =>
          deps.logger.error(
            { err: error },
            `Forecast refresh for ${label} failed`,
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
  for (const [userId, active] of actives) {
    const label = locationLabel(active.location);
    if (!answers.has(label)) continue;
    users.set(userId, {
      settings: found.get(userId)!.settings,
      active,
      cached: answers.get(label)!,
    });
  }
  return users;
}
