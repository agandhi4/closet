import { and, eq, inArray, type SQL, sql } from 'drizzle-orm';
import type { Queryable } from '../../db/client';
import { userWeather, weatherForecast, weatherNormals } from '../../db/schema';
import { selectScalars } from '../../db/select-scalars';
import type { Forecast } from '../../weather/forecast';
import type { Location } from '../../weather/location';
import type { ClimateNormals } from '../../weather/normals';
import {
  DEFAULT_TEMPERATURE_UNIT,
  type Feeling,
  OFFSET_LIMIT,
  OFFSET_STEP,
  type TemperatureUnit,
} from '../../weather/temperature';

/**
 * The weather's rows (#14): a user's settings (user_weather) and the
 * caches (weather_forecast, weather_normals). One writer per piece of
 * state: the home (setHome, clearHome), the phone's location (setHere,
 * clearHere), the unit (setTemperatureUnit), the offset
 * (nudgeTemperatureOffset, resetTemperatureOffset); the caches are the
 * service's alone (src/web/weather/service.ts).
 * Locations arrive rounded (src/weather/location.ts): nothing here rounds,
 * and nothing takes a location that was not.
 */

/**
 * How long the phone's location stands for the user's weather before it is
 * home again: a day out, not a move. Tapping "Use my location" again renews
 * it; a trip's forecast is #10's (its destination, geocoded).
 */
export const HERE_FRESH_HOURS = 12;

export interface WeatherSettings {
  home: { name: string; location: Location } | null;
  here: { location: Location; locatedAt: Date } | null;
  /** °C added to the feels-like before matching. */
  offset: number;
  unit: TemperatureUnit;
}

/** A user who never set anything. */
export const NO_WEATHER_SETTINGS: WeatherSettings = {
  home: null,
  here: null,
  offset: 0,
  unit: DEFAULT_TEMPERATURE_UNIT,
};

/** Where the user's weather is for now, and what to call it. */
export interface ActiveLocation {
  location: Location;
  source: 'here' | 'home';
  /** The home's name; null for the phone's location (there is no reverse geocoding). */
  name: string | null;
}

export function activeLocation(
  settings: WeatherSettings,
  now: Date,
): ActiveLocation | null {
  const { here, home } = settings;
  if (here && isFresh(here.locatedAt, now)) {
    return { location: here.location, source: 'here', name: null };
  }
  return home
    ? { location: home.location, source: 'home', name: home.name }
    : null;
}

export function isFresh(locatedAt: Date, now: Date): boolean {
  return now.getTime() - locatedAt.getTime() < HERE_FRESH_HOURS * 3_600_000;
}

export async function findWeatherSettings(
  db: Queryable,
  userId: number,
): Promise<WeatherSettings> {
  const [row] = await db
    .select()
    .from(userWeather)
    .where(eq(userWeather.userId, userId));
  return row ? settingsOf(row) : NO_WEATHER_SETTINGS;
}

/** The user's settings, and the active location's forecast cache row. */
export interface WeatherWithForecast {
  settings: WeatherSettings;
  forecast: { row: CacheRow<Forecast> | undefined } | null;
}

/**
 * weatherWithForecastSql's value, as JSON has it: numerics are numbers,
 * timestamps ISO strings (readWeatherWithForecast makes them Dates).
 */
export interface WeatherWithForecastJson {
  settings: Omit<typeof userWeather.$inferSelect, 'hereLocatedAt'> & {
    hereLocatedAt: string | null;
  };
  joinedLatitude: number | null;
  joinedLongitude: number | null;
  value: Forecast | null;
  fetchedAt: string | null;
  attemptedAt: string | null;
}

/**
 * The user's settings and the forecast cache row of the location they make
 * active at `now` (activeLocation's rule in SQL: the phone's location while
 * younger than HERE_FRESH_HOURS, else home), as a scalar subquery, so a page
 * reads it in one statement with its other reads (selectScalars: the
 * outfit gallery's ideasFor, #168). Null when the user never set anything.
 * findWeatherWithForecast reads it on its own.
 */
export function weatherWithForecastSql(
  userId: number,
  now: Date,
): SQL<WeatherWithForecastJson | null> {
  const { json, from } = weatherWithForecastParts(now);
  return sql<WeatherWithForecastJson | null>`(
    select ${json} ${from} where ${eq(userWeather.userId, userId)})`;
}

/**
 * weatherWithForecastSql for several users, as one scalar subquery (a JSON
 * list, one element per user with a settings row): a batch job's read
 * (findWeathersWithForecast, #165), where a read per user was an N+1.
 */
export function weathersWithForecastSql(
  userIds: readonly number[],
  now: Date,
): SQL<WeatherWithForecastJson[]> {
  const { json, from } = weatherWithForecastParts(now);
  return sql<WeatherWithForecastJson[]>`(
    select coalesce(json_agg(${json}), '[]') ${from}
    where ${inArray(userWeather.userId, [...userIds])})`;
}

// The one definition of a user's weather-with-forecast value and the join
// it is read from; the two subqueries above differ only in their WHERE.
function weatherWithForecastParts(now: Date): { json: SQL; from: SQL } {
  const hereSince = new Date(now.getTime() - HERE_FRESH_HOURS * 3_600_000);
  const hereFresh = sql`${userWeather.hereLocatedAt} > ${hereSince}`;
  const latitude = sql`case when ${hereFresh}
    then ${userWeather.hereLatitude} else ${userWeather.homeLatitude} end`;
  const longitude = sql`case when ${hereFresh}
    then ${userWeather.hereLongitude} else ${userWeather.homeLongitude} end`;
  return {
    json: sql`json_build_object(
      'settings', json_build_object(
        'userId', ${userWeather.userId},
        'homeName', ${userWeather.homeName},
        'homeLatitude', ${userWeather.homeLatitude},
        'homeLongitude', ${userWeather.homeLongitude},
        'hereLatitude', ${userWeather.hereLatitude},
        'hereLongitude', ${userWeather.hereLongitude},
        'hereLocatedAt', ${userWeather.hereLocatedAt},
        'temperatureOffset', ${userWeather.temperatureOffset},
        'temperatureUnit', ${userWeather.temperatureUnit}
      ),
      'joinedLatitude', ${latitude},
      'joinedLongitude', ${longitude},
      'value', ${weatherForecast.forecast},
      'fetchedAt', ${weatherForecast.fetchedAt},
      'attemptedAt', ${weatherForecast.attemptedAt}
    )`,
    from: sql`from ${userWeather}
    left join ${weatherForecast}
      on ${weatherForecast.latitude} = ${latitude}
      and ${weatherForecast.longitude} = ${longitude}`,
  };
}

/**
 * weatherWithForecastSql's value as userWeather (service.ts) decides from
 * it. `forecast` is null unless the location the statement joined is the
 * one activeLocation picks, so the two rules can never serve one place's
 * forecast for another; its `row` is undefined when that location has no
 * cache row yet.
 */
export function readWeatherWithForecast(
  json: WeatherWithForecastJson | null,
  now: Date,
): WeatherWithForecast {
  if (!json) return { settings: NO_WEATHER_SETTINGS, forecast: null };
  const { hereLocatedAt } = json.settings;
  const settings = settingsOf({
    ...json.settings,
    hereLocatedAt: hereLocatedAt === null ? null : new Date(hereLocatedAt),
  });
  const active = activeLocation(settings, now);
  const joined = json.joinedLatitude !== null &&
    json.joinedLongitude !== null && {
      latitude: json.joinedLatitude,
      longitude: json.joinedLongitude,
    };
  if (!active || !joined || !sameLocation(joined, active.location)) {
    return { settings, forecast: null };
  }
  const { value, fetchedAt, attemptedAt } = json;
  return {
    settings,
    forecast: {
      // attempted_at is never null in a row: null is "none joined".
      row:
        attemptedAt === null
          ? undefined
          : {
              value,
              fetchedAt: fetchedAt === null ? null : new Date(fetchedAt),
              attemptedAt: new Date(attemptedAt),
            },
    },
  };
}

/**
 * The user's settings and their active location's forecast cache row, in
 * one statement (weatherWithForecastSql), for userWeather (service.ts): one
 * round trip where settings then row were two, on every page's weather
 * line, Today and its ideas (#158).
 */
export async function findWeatherWithForecast(
  db: Queryable,
  userId: number,
  now: Date,
): Promise<WeatherWithForecast> {
  const { weather } = await selectScalars(db, {
    weather: weatherWithForecastSql(userId, now),
  });
  return readWeatherWithForecast(weather, now);
}

/**
 * findWeatherWithForecast for several users in one statement
 * (weathersWithForecastSql): the batch job's (refreshForecastsFor). A user
 * without a settings row is absent from the map.
 */
export async function findWeathersWithForecast(
  db: Queryable,
  userIds: readonly number[],
  now: Date,
): Promise<Map<number, WeatherWithForecast>> {
  const found = new Map<number, WeatherWithForecast>();
  if (userIds.length === 0) return found;
  const { weathers } = await selectScalars(db, {
    weathers: weathersWithForecastSql([...new Set(userIds)], now),
  });
  for (const json of weathers) {
    found.set(json.settings.userId, readWeatherWithForecast(json, now));
  }
  return found;
}

function sameLocation(a: Location, b: Location): boolean {
  return a.latitude === b.latitude && a.longitude === b.longitude;
}

function settingsOf(row: typeof userWeather.$inferSelect): WeatherSettings {
  // The check constraints keep each group all set or all null.
  return {
    home:
      row.homeName !== null &&
      row.homeLatitude !== null &&
      row.homeLongitude !== null
        ? {
            name: row.homeName,
            location: {
              latitude: row.homeLatitude,
              longitude: row.homeLongitude,
            },
          }
        : null,
    here:
      row.hereLatitude !== null &&
      row.hereLongitude !== null &&
      row.hereLocatedAt !== null
        ? {
            location: {
              latitude: row.hereLatitude,
              longitude: row.hereLongitude,
            },
            locatedAt: row.hereLocatedAt,
          }
        : null,
    offset: row.temperatureOffset,
    unit: row.temperatureUnit,
  };
}

type SettingsColumns = Partial<Omit<typeof userWeather.$inferInsert, 'userId'>>;

/** Creates the row with `values` or changes only those columns of it. */
async function upsertSettings(
  db: Queryable,
  userId: number,
  values: SettingsColumns,
): Promise<void> {
  await db
    .insert(userWeather)
    .values({ userId, ...values })
    .onConflictDoUpdate({ target: userWeather.userId, set: values });
}

export function setHome(
  db: Queryable,
  userId: number,
  home: { name: string; location: Location },
): Promise<void> {
  return upsertSettings(db, userId, {
    homeName: home.name,
    homeLatitude: home.location.latitude,
    homeLongitude: home.location.longitude,
  });
}

export async function clearHome(db: Queryable, userId: number): Promise<void> {
  await db
    .update(userWeather)
    .set({ homeName: null, homeLatitude: null, homeLongitude: null })
    .where(eq(userWeather.userId, userId));
}

export function setHere(
  db: Queryable,
  userId: number,
  location: Location,
  at: Date,
): Promise<void> {
  return upsertSettings(db, userId, {
    hereLatitude: location.latitude,
    hereLongitude: location.longitude,
    hereLocatedAt: at,
  });
}

export async function clearHere(db: Queryable, userId: number): Promise<void> {
  await db
    .update(userWeather)
    .set({ hereLatitude: null, hereLongitude: null, hereLocatedAt: null })
    .where(eq(userWeather.userId, userId));
}

export function setTemperatureUnit(
  db: Queryable,
  userId: number,
  unit: TemperatureUnit,
): Promise<void> {
  return upsertSettings(db, userId, { temperatureUnit: unit });
}

/**
 * One "too warm" or "too cold" (src/weather/temperature.ts, nudgeOffset's
 * rule) as one statement, so two quick taps both count. Returns the new
 * offset. The web's feedback today; the gallery's "say why not" (#9) next.
 */
export async function nudgeTemperatureOffset(
  db: Queryable,
  userId: number,
  feeling: Feeling,
): Promise<number> {
  const step = feeling === 'too-warm' ? OFFSET_STEP : -OFFSET_STEP;
  const [row] = await db
    .insert(userWeather)
    .values({ userId, temperatureOffset: step })
    .onConflictDoUpdate({
      target: userWeather.userId,
      set: {
        temperatureOffset: sql`least(${OFFSET_LIMIT}, greatest(${-OFFSET_LIMIT}, ${userWeather.temperatureOffset} + ${step}))`,
      },
    })
    .returning({ offset: userWeather.temperatureOffset });
  return row.offset;
}

export async function resetTemperatureOffset(
  db: Queryable,
  userId: number,
): Promise<void> {
  await db
    .update(userWeather)
    .set({ temperatureOffset: 0 })
    .where(eq(userWeather.userId, userId));
}

/**
 * A location's cache row, as the service reads it (location-cache.ts): the
 * last good answer and when it was fetched (both null until one was), and
 * the last attempt, good or not.
 */
export interface CacheRow<T> {
  value: T | null;
  fetchedAt: Date | null;
  attemptedAt: Date;
}

/** A cache row as JSON has it: the timestamps ISO strings (readCacheRow). */
export interface CacheRowJson<T> {
  value: T | null;
  fetchedAt: string | null;
  attemptedAt: string;
}

/**
 * The forecast cache row at `location` as a scalar subquery (null: none),
 * for a caller that reads it with its other reads and hands it to
 * forecastFor as the row it knows (tripForecast).
 */
export function forecastRowSql(
  location: Location,
): SQL<CacheRowJson<Forecast> | null> {
  return sql<CacheRowJson<Forecast> | null>`(
    select json_build_object(
      'value', ${weatherForecast.forecast},
      'fetchedAt', ${weatherForecast.fetchedAt},
      'attemptedAt', ${weatherForecast.attemptedAt}
    )
    from ${weatherForecast} where ${forecastAt(location)})`;
}

/** forecastRowSql for the climate normals (normalsFor). */
export function normalsRowSql(
  location: Location,
): SQL<CacheRowJson<ClimateNormals> | null> {
  return sql<CacheRowJson<ClimateNormals> | null>`(
    select json_build_object(
      'value', ${weatherNormals.normals},
      'fetchedAt', ${weatherNormals.fetchedAt},
      'attemptedAt', ${weatherNormals.attemptedAt}
    )
    from ${weatherNormals} where ${normalsAt(location)})`;
}

/** A cache row read as JSON, as the service reads one (undefined: none). */
export function readCacheRow<T>(
  json: CacheRowJson<T> | null,
): CacheRow<T> | undefined {
  if (!json) return undefined;
  return {
    value: json.value,
    fetchedAt: json.fetchedAt === null ? null : new Date(json.fetchedAt),
    attemptedAt: new Date(json.attemptedAt),
  };
}

/** How the user feels temperatures and reads them: the settings' offset and unit. */
export type TemperaturePrefs = Pick<WeatherSettings, 'offset' | 'unit'>;

/**
 * The user's offset and unit as a scalar subquery (null without a settings
 * row), for a read that needs no location of theirs: a trip's forecast is
 * the destination's, so their home and phone stay unread (tripForecast).
 */
export function temperaturePrefsSql(
  userId: number,
): SQL<TemperaturePrefs | null> {
  return sql<TemperaturePrefs | null>`(
    select json_build_object(
      'offset', ${userWeather.temperatureOffset},
      'unit', ${userWeather.temperatureUnit}
    )
    from ${userWeather} where ${eq(userWeather.userId, userId)})`;
}

/** temperaturePrefsSql's value, a user who never set anything's defaults for none. */
export function readTemperaturePrefs(
  json: TemperaturePrefs | null,
): TemperaturePrefs {
  return (
    json ?? {
      offset: NO_WEATHER_SETTINGS.offset,
      unit: NO_WEATHER_SETTINGS.unit,
    }
  );
}

function forecastAt(location: Location) {
  return and(
    eq(weatherForecast.latitude, location.latitude),
    eq(weatherForecast.longitude, location.longitude),
  );
}

export async function findForecastRow(
  db: Queryable,
  location: Location,
): Promise<CacheRow<Forecast> | undefined> {
  const [row] = await db
    .select({
      value: weatherForecast.forecast,
      fetchedAt: weatherForecast.fetchedAt,
      attemptedAt: weatherForecast.attemptedAt,
    })
    .from(weatherForecast)
    .where(forecastAt(location));
  return row;
}

export async function saveForecast(
  db: Queryable,
  location: Location,
  forecast: Forecast,
  at: Date,
): Promise<void> {
  const values = { forecast, fetchedAt: at, attemptedAt: at };
  await db
    .insert(weatherForecast)
    .values({ ...location, ...values })
    .onConflictDoUpdate({
      target: [weatherForecast.latitude, weatherForecast.longitude],
      set: values,
    });
}

/** A failed refresh: the last good answer stays, the attempt is noted. */
export async function recordFailedForecast(
  db: Queryable,
  location: Location,
  at: Date,
): Promise<void> {
  await db
    .insert(weatherForecast)
    .values({ ...location, attemptedAt: at })
    .onConflictDoUpdate({
      target: [weatherForecast.latitude, weatherForecast.longitude],
      set: { attemptedAt: at },
    });
}

function normalsAt(location: Location) {
  return and(
    eq(weatherNormals.latitude, location.latitude),
    eq(weatherNormals.longitude, location.longitude),
  );
}

export async function findNormalsRow(
  db: Queryable,
  location: Location,
): Promise<CacheRow<ClimateNormals> | undefined> {
  const [row] = await db
    .select({
      value: weatherNormals.normals,
      fetchedAt: weatherNormals.fetchedAt,
      attemptedAt: weatherNormals.attemptedAt,
    })
    .from(weatherNormals)
    .where(normalsAt(location));
  return row;
}

export async function saveNormals(
  db: Queryable,
  location: Location,
  normals: ClimateNormals,
  at: Date,
): Promise<void> {
  const values = { normals, fetchedAt: at, attemptedAt: at };
  await db
    .insert(weatherNormals)
    .values({ ...location, ...values })
    .onConflictDoUpdate({
      target: [weatherNormals.latitude, weatherNormals.longitude],
      set: values,
    });
}

/** A failed refresh: the last good normals stay, the attempt is noted. */
export async function recordFailedNormals(
  db: Queryable,
  location: Location,
  at: Date,
): Promise<void> {
  await db
    .insert(weatherNormals)
    .values({ ...location, attemptedAt: at })
    .onConflictDoUpdate({
      target: [weatherNormals.latitude, weatherNormals.longitude],
      set: { attemptedAt: at },
    });
}
