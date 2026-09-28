import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureLogs } from '../../../test/support/log-capture';
import type { Db } from '../../db/client';
import type { Location } from '../../weather/location';
import type { Forecast } from '../../weather/forecast';
import type { KnownRow, ReadOptions } from './location-cache';
import { findWeathersWithForecast } from './queries';
import {
  BATCH_REFRESH_CONCURRENCY,
  BATCH_REFRESH_DEADLINE_MS,
  refreshForecastsFor,
  type WeatherService,
} from './service';

vi.mock('./queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./queries')>()),
  findWeathersWithForecast: vi.fn(),
}));

/**
 * A batch job's forecast refresh (the morning reminders, the daily
 * re-plan): N people at N stale places cost about one fetch's bound, not N
 * in turn, because a minute's run that overruns skips the next minute.
 * Fake timers stand in for Open-Meteo's 10 s.
 */

const FETCH_MS = 10_000;

// User n lives at a place of their own; user 0 has no location.
const placeOf = (userId: number): Location => ({
  latitude: 40 + userId / 100,
  longitude: -73.98,
});

function slowWeather() {
  const asked: {
    location: Location;
    read: ReadOptions | undefined;
    known: KnownRow<Forecast> | undefined;
  }[] = [];
  const weather: WeatherService = {
    forecastFor: (location, read, known) => {
      asked.push({ location, read, known });
      return new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              forecast: { timeZone: 'America/New_York', days: [] },
              fetchedAt: new Date(),
            }),
          FETCH_MS,
        ),
      );
    },
    normalsFor: () => Promise.reject(new Error('never asked')),
    searchPlaces: () => Promise.resolve([]),
    settled: () => Promise.resolve(),
  };
  return { weather, asked };
}

// Every user's settings, in the one statement the batch reads them in; no
// place has a cache row yet.
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(findWeathersWithForecast).mockImplementation((_db, userIds) =>
    Promise.resolve(
      new Map(
        userIds.map((userId) => [
          userId,
          {
            settings: {
              home:
                userId === 0
                  ? null
                  : { name: `Place ${userId}`, location: placeOf(userId) },
              here: null,
              unit: 'fahrenheit',
              offset: userId,
            },
            forecast: userId === 0 ? null : { row: undefined },
          },
        ]),
      ),
    ),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe('refreshForecastsFor', () => {
  it('refreshes N distinct stale places within about one fetch, each once, with fresh reads', async () => {
    const { weather, asked } = slowWeather();
    const { logger, logs } = captureLogs();
    const users = [0, 1, 2, 3, 4];
    let done = false;
    const batch = refreshForecastsFor(
      { db: {} as Db, weather, logger },
      // Users asked twice (two devices, both kinds) are one place.
      [...users, 1, 2],
      new Date('2030-01-15T12:00:00Z'),
    ).then((answered) => {
      done = true;
      return answered;
    });
    await vi.advanceTimersByTimeAsync(FETCH_MS);
    const answered = await batch;
    expect(done).toBe(true);
    // Four places (user 0 has none), each asked once, fresh, all at once,
    // with the row the batch read (none yet), so the cache reads nothing.
    expect(asked).toHaveLength(4);
    expect(asked.every(({ read }) => read?.fresh === true)).toBe(true);
    expect(asked.every(({ known }) => known?.row === undefined)).toBe(true);
    expect(asked.every(({ known }) => known !== undefined)).toBe(true);
    // Each user's weather, for the job to decide from without reading it.
    expect([...answered.keys()].sort()).toEqual(users);
    expect(answered.get(0)).toMatchObject({ active: null, cached: null });
    expect(answered.get(3)).toMatchObject({
      settings: { offset: 3 },
      active: { location: placeOf(3), source: 'home' },
      cached: { forecast: { days: [] } },
    });
    expect(findWeathersWithForecast).toHaveBeenCalledTimes(1);
    expect(logs.messages('info')).toEqual([
      expect.stringMatching(
        /^Forecasts for 4 location\(s\) refreshed for a batch in \d+ ms$/,
      ),
    ]);
  });

  it('stops at its deadline however many places there are, and starts no fetch after it', async () => {
    const { weather, asked } = slowWeather();
    const { logger, logs } = captureLogs();
    const users = Array.from({ length: 12 }, (_, n) => n + 1);
    let done = false;
    const batch = refreshForecastsFor(
      { db: {} as Db, weather, logger },
      users,
      new Date('2030-01-15T12:00:00Z'),
    ).then((answered) => {
      done = true;
      return answered;
    });
    await vi.advanceTimersByTimeAsync(BATCH_REFRESH_DEADLINE_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const answered = await batch;
    expect(done).toBe(true);
    // The first round's four answered; the rest read on their own.
    expect([...answered.keys()]).toEqual([1, 2, 3, 4]);
    // Two rounds of four started by 12 s (0 s and 10 s); none after it.
    expect(asked).toHaveLength(2 * BATCH_REFRESH_CONCURRENCY);
    await vi.advanceTimersByTimeAsync(3 * FETCH_MS);
    expect(asked).toHaveLength(2 * BATCH_REFRESH_CONCURRENCY);
    expect(logs.messages('info')[0]).toMatch(
      /^Forecasts for 12 location\(s\) refreshed for a batch in \d+ ms; 8 not done by the deadline, read stale$/,
    );
  });

  it('never throws for a place whose refresh fails', async () => {
    const { logger, logs } = captureLogs();
    const weather: WeatherService = {
      ...slowWeather().weather,
      forecastFor: () => Promise.reject(new Error('pool ended')),
    };
    // Left out of the answer: the job reads that user's weather itself.
    await expect(
      refreshForecastsFor({ db: {} as Db, weather, logger }, [1], new Date()),
    ).resolves.toEqual(new Map());
    expect(logs.messages('error')).toEqual([
      'Forecast refresh for 40.01,-73.98 failed',
    ]);
  });
});
