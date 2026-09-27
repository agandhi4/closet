import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AppOptions } from '../../src/app';
import { addDays, todayIn } from '../../src/web/calendar/calendar-date';
import { forecastDayOf, weatherFor } from '../../src/seed/weather';
import type { DayForecast } from '../../src/weather/forecast';

/**
 * A stand-in for Open-Meteo, so no spec, CI run or screenshot ever calls the
 * real service (#14). An HTTP server on the loopback alias 127.0.0.2 (Linux
 * routes all of 127/8 to lo; macOS needs `sudo ifconfig lo0 alias
 * 127.0.0.2`), admitted by an address policy for that one address, like the
 * link import's shop (test/integration/link-sites.ts). Hand `options` to
 * createTestApp (`weather`) or createApp (the e2e test server,
 * test/support/test-server.ts).
 *
 * The forecast is the seed's simulated New York weather (src/seed/weather.ts,
 * forecastDayOf, the demo persona's days) from today in the requested zone:
 * deterministic for a date, and the weather the demo's planned week was
 * drawn for. The search knows a few places (PLACES).
 */

const STUB_IP = '127.0.0.2';
// Whose simulated weather it serves: Theo's, for every location.
const WEATHER_KEY = 'demo';

interface StubPlace {
  name: string;
  latitude: number;
  longitude: number;
  admin1: string;
  country: string;
}

/** What the search answers, by the lower-case query. */
export const PLACES: Readonly<Record<string, readonly StubPlace[]>> = {
  brooklyn: [
    {
      name: 'Brooklyn',
      latitude: 40.6501,
      longitude: -73.94958,
      admin1: 'New York',
      country: 'United States',
    },
  ],
  'fort greene': [
    {
      name: 'Fort Greene',
      latitude: 40.68982,
      longitude: -73.97625,
      admin1: 'New York',
      country: 'United States',
    },
  ],
  springfield: [
    {
      name: 'Springfield',
      latitude: 39.80172,
      longitude: -89.64371,
      admin1: 'Illinois',
      country: 'United States',
    },
    {
      name: 'Springfield',
      latitude: 42.10148,
      longitude: -72.58981,
      admin1: 'Massachusetts',
      country: 'United States',
    },
  ],
};

export interface WeatherStub {
  options: NonNullable<AppOptions['weather']>;
  /** Every request, path and query, in order. */
  hits: string[];
  /** From now on, answer every request with a 500 (true) or normally (false). */
  fail(failing: boolean): void;
  close(): Promise<void>;
}

/** Open-Meteo's forecast answer for `days` (the fields the app reads). */
export function forecastAnswer(days: readonly DayForecast[], timeZone: string) {
  const hours = days.flatMap((day) =>
    day.hours.map((h) => ({
      ...h,
      time: `${day.day}T${String(h.hour).padStart(2, '0')}:00`,
    })),
  );
  return {
    timezone: timeZone,
    hourly: {
      time: hours.map((h) => h.time),
      apparent_temperature: hours.map((h) => h.feelsLike),
      precipitation_probability: hours.map((h) => h.precipitationChance),
      weather_code: hours.map((h) => h.code),
    },
    daily: {
      time: days.map((d) => d.day),
      weather_code: days.map((d) => d.code),
      temperature_2m_max: days.map((d) => d.high),
      temperature_2m_min: days.map((d) => d.low),
      precipitation_probability_max: days.map((d) => d.precipitationChance),
    },
  };
}

export async function startWeatherStub(): Promise<WeatherStub> {
  const hits: string[] = [];
  let failing = false;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${STUB_IP}`);
    hits.push(`${url.pathname}${url.search}`);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (failing) return json(500, { error: true, reason: 'stubbed failure' });
    if (url.pathname === '/v1/forecast') {
      const timeZone = url.searchParams.get('timezone') ?? 'GMT';
      const count = Number(url.searchParams.get('forecast_days') ?? 7);
      const today = todayIn(timeZone, new Date());
      const days = weatherFor(WEATHER_KEY, today, count).map((w) =>
        forecastDayOf(WEATHER_KEY, w),
      );
      return json(200, forecastAnswer(days, timeZone));
    }
    if (url.pathname === '/v1/search') {
      const name = (url.searchParams.get('name') ?? '').toLowerCase();
      const results = PLACES[name];
      return json(200, results ? { results } : { generationtime_ms: 0.1 });
    }
    return json(404, { error: true, reason: 'Not found' });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, STUB_IP, resolve);
  });
  const { port } = server.address() as AddressInfo;
  const base = `http://${STUB_IP}:${port}`;
  return {
    options: {
      endpoints: {
        forecast: `${base}/v1/forecast`,
        geocoding: `${base}/v1/search`,
      },
      fetch: {
        destinations: {
          allowsAddress: (address) => address === STUB_IP,
          allowsPort: () => true,
        },
      },
    },
    hits,
    fail(value) {
      failing = value;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Today's date in `timeZone` plus `days`: what a spec expects the stub to cover. */
export function stubDay(timeZone: string, days = 0): string {
  return addDays(todayIn(timeZone, new Date()), days);
}
