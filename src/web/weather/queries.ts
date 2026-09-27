import { and, eq, sql } from 'drizzle-orm';
import type { Queryable } from '../../db/client';
import { userWeather, weatherForecast } from '../../db/schema';
import type { Forecast } from '../../weather/forecast';
import type { Location } from '../../weather/location';
import {
  DEFAULT_TEMPERATURE_UNIT,
  type Feeling,
  OFFSET_LIMIT,
  OFFSET_STEP,
  type TemperatureUnit,
} from '../../weather/temperature';

/**
 * The weather's rows (#14): a user's settings (user_weather) and the
 * forecast cache (weather_forecast). One writer per piece of state: the
 * home (setHome, clearHome), the phone's location (setHere, clearHere), the
 * unit (setTemperatureUnit), the offset (nudgeTemperatureOffset,
 * resetTemperatureOffset); the cache is the service's alone
 * (saveForecast, recordFailedFetch; src/web/weather/service.ts).
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
  if (!row) return NO_WEATHER_SETTINGS;
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

/** A cached forecast row, as the service reads it. */
export interface ForecastRow {
  forecast: Forecast | null;
  fetchedAt: Date | null;
  attemptedAt: Date;
}

function atLocation(location: Location) {
  return and(
    eq(weatherForecast.latitude, location.latitude),
    eq(weatherForecast.longitude, location.longitude),
  );
}

export async function findForecastRow(
  db: Queryable,
  location: Location,
): Promise<ForecastRow | undefined> {
  const [row] = await db
    .select({
      forecast: weatherForecast.forecast,
      fetchedAt: weatherForecast.fetchedAt,
      attemptedAt: weatherForecast.attemptedAt,
    })
    .from(weatherForecast)
    .where(atLocation(location));
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
export async function recordFailedFetch(
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
