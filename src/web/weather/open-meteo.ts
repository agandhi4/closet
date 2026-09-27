import { type Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  type DayForecast,
  type Forecast,
  FORECAST_DAYS,
  type HourForecast,
} from '../../weather/forecast';
import {
  COORDINATE_DECIMALS,
  type Location,
  roundedLocation,
} from '../../weather/location';
import {
  type ClimateNormals,
  climateNormals,
  type ObservedDay,
} from '../../weather/normals';
import type { OutboundFetcher } from '../security/outbound-fetch';

/**
 * Open-Meteo (https://open-meteo.com: free, no key, no account), the
 * weather's one provider (#14; plan section 7). The server calls it; the
 * PWA never does (its CSP names no other origin). Every request goes
 * through the outbound fetcher (src/web/security/outbound-fetch.ts: one
 * bounded fetcher, so a timeout, a size cap, pinned public addresses and a
 * host-only log line) with `hosts` set to the endpoint's own host: the
 * fixed-host allow-list, which a redirect cannot leave. A request carries
 * the rounded coordinates (or the typed city name) and nothing about the
 * user: no cookie, no id, the fetcher's fixed User-Agent.
 *
 * Climate normals, the "typical" days past FORECAST_DAYS (#10's trips), come
 * from the historical archive (ERA5 reanalysis: what the weather was, on a
 * ~10 km grid), not the climate API: that one serves CMIP6 model runs, a
 * model's simulated days whose average carries the model's bias and needs
 * a model chosen, where the archive's average is the place's recent record.
 * One request covers NORMAL_YEARS whole years of daily highs, lows,
 * feels-like and precipitation (about 140 KB, under the fetcher's 512 KB
 * cap; Open-Meteo counts it as ~260 of its free calls, once per location a
 * month), from which every calendar day's normal is computed
 * (src/weather/normals.ts).
 */

export interface WeatherEndpoints {
  /** The forecast API (`/v1/forecast`). */
  forecast: string;
  /** The geocoding search (`/v1/search`). */
  geocoding: string;
  /** The historical weather archive (`/v1/archive`): climate normals. */
  archive: string;
}

/** Production. Tests pass a stub's (test/support/weather-stub.ts). */
export const OPEN_METEO: WeatherEndpoints = {
  forecast: 'https://api.open-meteo.com/v1/forecast',
  geocoding: 'https://geocoding-api.open-meteo.com/v1/search',
  archive: 'https://archive-api.open-meteo.com/v1/archive',
};

/** How many places a city search offers. */
export const PLACE_RESULTS = 5;

/** A city the geocoding search found, rounded like every stored location. */
export interface Place {
  /** "Brooklyn, New York, United States": what the profile shows and stores. */
  label: string;
  location: Location;
}

export interface WeatherClient {
  /** FORECAST_DAYS days from today, hours in `timeZone`. */
  forecast(location: Location): Promise<Forecast>;
  /** Every calendar day's normals over `years` (whole years, inclusive). */
  normals(
    location: Location,
    years: { first: number; last: number },
  ): Promise<ClimateNormals>;
  searchPlaces(query: string): Promise<Place[]>;
}

/** An answer that is not the shape Open-Meteo documents. */
export class WeatherResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WeatherResponseError';
  }
}

const Numbers = Type.Array(Type.Union([Type.Number(), Type.Null()]));

// Only what the app reads; Open-Meteo's other fields pass unchecked.
const ForecastAnswer = Type.Object({
  hourly: Type.Object({
    time: Type.Array(Type.String()),
    apparent_temperature: Numbers,
    precipitation_probability: Numbers,
    weather_code: Numbers,
  }),
  daily: Type.Object({
    time: Type.Array(Type.String()),
    weather_code: Numbers,
    temperature_2m_max: Numbers,
    temperature_2m_min: Numbers,
    precipitation_probability_max: Numbers,
  }),
});
type ForecastAnswer = Static<typeof ForecastAnswer>;

const ArchiveAnswer = Type.Object({
  daily: Type.Object({
    time: Type.Array(Type.String()),
    temperature_2m_max: Numbers,
    temperature_2m_min: Numbers,
    apparent_temperature_max: Numbers,
    apparent_temperature_min: Numbers,
    precipitation_sum: Numbers,
  }),
});
type ArchiveAnswer = Static<typeof ArchiveAnswer>;

const GeocodingAnswer = Type.Object({
  // Absent when nothing matched.
  results: Type.Optional(
    Type.Array(
      Type.Object({
        name: Type.String(),
        latitude: Type.Number(),
        longitude: Type.Number(),
        admin1: Type.Optional(Type.String()),
        country: Type.Optional(Type.String()),
      }),
    ),
  ),
});

// 'YYYY-MM-DDTHH:MM' in the requested zone.
const LOCAL_HOUR = /^(\d{4}-\d{2}-\d{2})T(\d{2}):\d{2}$/;
const LOCAL_DAY = /^\d{4}-\d{2}-\d{2}$/;
// A missing weather code reads as overcast (conditionOf's fallback too).
const OVERCAST = 3;

export function createOpenMeteoClient(options: {
  fetcher: OutboundFetcher;
  /** APP_TIMEZONE: the forecast's days and hours are the household's. */
  timeZone: string;
  endpoints?: WeatherEndpoints;
}): WeatherClient {
  const { fetcher, timeZone, endpoints = OPEN_METEO } = options;

  async function getJson(endpoint: string, query: URLSearchParams) {
    const url = new URL(endpoint);
    url.search = query.toString();
    const fetched = await fetcher.fetch(url.href, {
      accept: ['json'],
      hosts: [url.hostname],
    });
    try {
      return JSON.parse(fetched.body.toString('utf8')) as unknown;
    } catch {
      throw new WeatherResponseError('The answer is not JSON');
    }
  }

  return {
    async forecast(location) {
      const answer = await getJson(
        endpoints.forecast,
        new URLSearchParams({
          latitude: location.latitude.toFixed(COORDINATE_DECIMALS),
          longitude: location.longitude.toFixed(COORDINATE_DECIMALS),
          hourly: 'apparent_temperature,precipitation_probability,weather_code',
          daily:
            'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
          timezone: timeZone,
          forecast_days: String(FORECAST_DAYS),
        }),
      );
      if (!Value.Check(ForecastAnswer, answer)) {
        throw new WeatherResponseError(
          'The forecast is not the documented shape',
        );
      }
      return { timeZone, days: forecastDays(answer) };
    },

    async normals(location, years) {
      const answer = await getJson(
        endpoints.archive,
        new URLSearchParams({
          latitude: location.latitude.toFixed(COORDINATE_DECIMALS),
          longitude: location.longitude.toFixed(COORDINATE_DECIMALS),
          start_date: `${years.first}-01-01`,
          end_date: `${years.last}-12-31`,
          daily:
            'temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_sum',
          timezone: timeZone,
        }),
      );
      if (!Value.Check(ArchiveAnswer, answer)) {
        throw new WeatherResponseError(
          'The archive answer is not the documented shape',
        );
      }
      const observed = observedDays(answer, years);
      if (observed.length === 0) {
        throw new WeatherResponseError('The archive has no complete days');
      }
      return climateNormals(observed, years);
    },

    async searchPlaces(query) {
      const answer = await getJson(
        endpoints.geocoding,
        new URLSearchParams({
          name: query,
          count: String(PLACE_RESULTS),
          language: 'en',
          format: 'json',
        }),
      );
      if (!Value.Check(GeocodingAnswer, answer)) {
        throw new WeatherResponseError(
          'The search answer is not the documented shape',
        );
      }
      return (answer.results ?? []).flatMap((result) => {
        const location = roundedLocation(result.latitude, result.longitude);
        if (!location) return [];
        const label = [result.name, result.admin1, result.country]
          .filter((part, i, parts) => part && parts.indexOf(part) === i)
          .join(', ');
        return [{ label, location }];
      });
    },
  };
}

/**
 * The answer's days, each with its hours. A day without a high or low is
 * left out; an hour without a feels-like is left out of its day; a missing
 * chance of precipitation reads as none.
 */
function forecastDays({ hourly, daily }: ForecastAnswer): DayForecast[] {
  if (
    hourly.apparent_temperature.length !== hourly.time.length ||
    hourly.precipitation_probability.length !== hourly.time.length ||
    hourly.weather_code.length !== hourly.time.length ||
    daily.weather_code.length !== daily.time.length ||
    daily.temperature_2m_max.length !== daily.time.length ||
    daily.temperature_2m_min.length !== daily.time.length ||
    daily.precipitation_probability_max.length !== daily.time.length
  ) {
    throw new WeatherResponseError('The forecast series differ in length');
  }
  const hoursByDay = new Map<string, HourForecast[]>();
  hourly.time.forEach((time, i) => {
    const match = LOCAL_HOUR.exec(time);
    const feelsLike = hourly.apparent_temperature[i];
    if (!match || feelsLike === null) return;
    const hours = hoursByDay.get(match[1]) ?? [];
    hours.push({
      hour: Number(match[2]),
      feelsLike,
      precipitationChance: hourly.precipitation_probability[i] ?? 0,
      code: hourly.weather_code[i] ?? OVERCAST,
    });
    hoursByDay.set(match[1], hours);
  });
  return daily.time.flatMap((day, i) => {
    const high = daily.temperature_2m_max[i];
    const low = daily.temperature_2m_min[i];
    if (!LOCAL_DAY.test(day) || high === null || low === null) return [];
    return [
      {
        day,
        code: daily.weather_code[i] ?? OVERCAST,
        high,
        low,
        precipitationChance: daily.precipitation_probability_max[i] ?? 0,
        hours: hoursByDay.get(day) ?? [],
      },
    ];
  });
}

/**
 * The archive's days within `years` that have every value (the newest days
 * of a year still being compiled come back null and are left out).
 */
function observedDays(
  { daily }: ArchiveAnswer,
  years: { first: number; last: number },
): ObservedDay[] {
  const series = [
    daily.temperature_2m_max,
    daily.temperature_2m_min,
    daily.apparent_temperature_max,
    daily.apparent_temperature_min,
    daily.precipitation_sum,
  ];
  if (series.some((values) => values.length !== daily.time.length)) {
    throw new WeatherResponseError('The archive series differ in length');
  }
  const first = `${years.first}-01-01`;
  const last = `${years.last}-12-31`;
  return daily.time.flatMap((day, i) => {
    const [high, low, feelsHigh, feelsLow, precipitation] = series.map(
      (values) => values[i],
    );
    if (
      !LOCAL_DAY.test(day) ||
      day < first ||
      day > last ||
      high === null ||
      low === null ||
      feelsHigh === null ||
      feelsLow === null ||
      precipitation === null
    ) {
      return [];
    }
    return [{ day, high, low, feelsHigh, feelsLow, precipitation }];
  });
}
