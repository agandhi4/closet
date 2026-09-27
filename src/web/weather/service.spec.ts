import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureLogs } from '../../../test/support/log-capture';
import type { Db } from '../../db/client';
import type { Forecast } from '../../weather/forecast';
import type { ClimateNormals } from '../../weather/normals';
import type { WeatherClient } from './open-meteo';
import {
  findForecastRow,
  findNormalsRow,
  saveForecast,
  saveNormals,
} from './queries';
import { createWeatherService } from './service';

vi.mock('./queries', () => ({
  findForecastRow: vi.fn(),
  findNormalsRow: vi.fn(),
  saveForecast: vi.fn(),
  saveNormals: vi.fn(),
  recordFailedForecast: vi.fn(),
  recordFailedNormals: vi.fn(),
}));

/**
 * What the service asks the location cache to treat as "another question"
 * (#112's sweep): a forecast requested in another zone than APP_TIMEZONE,
 * and normals of years that are no longer the last ten. Either is refetched
 * however young its row is. The cache's own discipline is
 * location-cache.spec.ts.
 */

const HERE = { latitude: 40.69, longitude: -73.98 };
const ZONE = 'America/New_York';

function service(now: Date) {
  const client = {
    forecast: vi.fn(() =>
      Promise.resolve<Forecast>({ timeZone: ZONE, days: [] }),
    ),
    normals: vi.fn((_location, years: { first: number; last: number }) =>
      Promise.resolve<ClimateNormals>({ years, days: {} }),
    ),
    searchPlaces: vi.fn(),
  } satisfies WeatherClient;
  const { logger, logs } = captureLogs();
  const weather = createWeatherService({
    db: {} as Db,
    client,
    logger,
    timeZone: ZONE,
    now: () => now,
  });
  return { weather, client, logs };
}

beforeEach(() => {
  vi.mocked(saveForecast).mockResolvedValue();
  vi.mocked(saveNormals).mockResolvedValue();
});

describe('createWeatherService', () => {
  it("refetches a young forecast grouped in another zone, and serves this zone's", async () => {
    const now = new Date('2026-09-27T12:00:00Z');
    const fetchedAt = new Date(now.getTime() - 5 * 60_000);
    vi.mocked(findForecastRow).mockResolvedValue({
      value: { timeZone: 'America/Chicago', days: [] },
      fetchedAt,
      attemptedAt: fetchedAt,
    });
    const { weather, client, logs } = service(now);

    await expect(weather.forecastFor(HERE)).resolves.toEqual({
      forecast: { timeZone: ZONE, days: [] },
      fetchedAt: now,
    });
    expect(client.forecast).toHaveBeenCalledTimes(1);
    expect(logs.messages('info')[0]).toBe(
      'Forecast for 40.69,-73.98: the one from 2026-09-27T11:55:00.000Z is for America/Chicago, not America/New_York; not served',
    );
  });

  it('keeps serving a young forecast in this zone', async () => {
    const now = new Date('2026-09-27T12:00:00Z');
    const fetchedAt = new Date(now.getTime() - 5 * 60_000);
    const forecast: Forecast = { timeZone: ZONE, days: [] };
    vi.mocked(findForecastRow).mockResolvedValue({
      value: forecast,
      fetchedAt,
      attemptedAt: fetchedAt,
    });
    const { weather, client } = service(now);
    await expect(weather.forecastFor(HERE)).resolves.toEqual({
      forecast,
      fetchedAt,
    });
    expect(client.forecast).not.toHaveBeenCalled();
  });

  it("refetches the normals once the household's New Year moves their years", async () => {
    // 15 January 2027 in New York: the last ten whole years are 2017-2026.
    // The row was fetched on New Year's Eve, two weeks ago, for 2016-2025.
    const now = new Date('2027-01-15T17:00:00Z');
    const fetchedAt = new Date('2026-12-31T17:00:00Z');
    vi.mocked(findNormalsRow).mockResolvedValue({
      value: { years: { first: 2016, last: 2025 }, days: {} },
      fetchedAt,
      attemptedAt: fetchedAt,
    });
    const { weather, client, logs } = service(now);

    const cached = await weather.normalsFor(HERE);
    expect(cached?.normals.years).toEqual({ first: 2017, last: 2026 });
    expect(client.normals).toHaveBeenCalledWith(HERE, {
      first: 2017,
      last: 2026,
    });
    expect(logs.messages('info')[0]).toBe(
      'Climate normals for 40.69,-73.98: the one from 2026-12-31T17:00:00.000Z is of 2016-2025, not 2017-2026; not served',
    );
  });

  it("serves the normals through New Year's Eve in New York, already the next year in UTC", async () => {
    const now = new Date('2027-01-01T04:30:00Z');
    const fetchedAt = new Date('2026-12-20T17:00:00Z');
    const normals: ClimateNormals = {
      years: { first: 2016, last: 2025 },
      days: {},
    };
    vi.mocked(findNormalsRow).mockResolvedValue({
      value: normals,
      fetchedAt,
      attemptedAt: fetchedAt,
    });
    const { weather, client } = service(now);
    await expect(weather.normalsFor(HERE)).resolves.toEqual({
      normals,
      fetchedAt,
    });
    expect(client.normals).not.toHaveBeenCalled();
  });
});
