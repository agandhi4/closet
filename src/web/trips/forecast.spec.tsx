import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../../db/client';
import type { DayForecast, HourForecast } from '../../weather/forecast';
import type { PickedLocation } from '../../weather/location';
import { type DayNormals, monthDayOf } from '../../weather/normals';
import { addDays } from '../../calendar-date';
import { renderToString } from '../render';
import type { CachedNormals, WeatherService } from '../weather/service';
import { tripForecast } from './forecast';
import type { TripRow } from './queries';
import { TripWeather } from './weather';

// The one statement tripForecast reads: no settings row (the defaults) and
// no cache rows (the service's stand-ins below answer).
vi.mock('../../db/select-scalars', () => ({
  selectScalars: vi.fn(() =>
    Promise.resolve({ prefs: null, forecast: null, normals: null }),
  ),
}));

/**
 * A trip whose near days the forecast reaches and whose far days it does
 * not, at a new destination where the forecast fails and the archive
 * answers (#112's sweep): the far days keep their typical weather, the near
 * ones say the forecast is unavailable, on the page and in the model
 * get_trip reads.
 */

const TODAY = '2026-09-26';
const PLACE: PickedLocation = {
  latitude: 30.27,
  longitude: -97.74,
  timeZone: 'America/Chicago',
};
const DAY_NORMALS: DayNormals = {
  high: 28,
  low: 18,
  feelsHigh: 30,
  feelsLow: 18,
  rainChance: 20,
};

function normalsFor(first: string, count: number): CachedNormals {
  const days: Record<string, DayNormals> = {};
  for (let n = 0; n < count; n += 1) {
    days[monthDayOf(addDays(first, n))] = DAY_NORMALS;
  }
  return {
    normals: { years: { first: 2016, last: 2025 }, days },
    fetchedAt: new Date('2026-09-26T12:00:00Z'),
  };
}

function trip(
  from: number,
  to: number,
  location: PickedLocation | null = PLACE,
): TripRow {
  return {
    id: 7,
    name: 'Austin',
    destination: 'Austin, Texas, United States',
    startsOn: addDays(TODAY, from),
    endsOn: addDays(TODAY, to),
    notes: null,
    location,
  };
}

function weather(forecast: WeatherService['forecastFor']): WeatherService {
  return {
    timeZone: 'America/New_York',
    forecastFor: forecast,
    normalsFor: () => Promise.resolve(normalsFor(TODAY, 40)),
    searchPlaces: () => Promise.resolve([]),
    settled: () => Promise.resolve(),
  };
}

describe('tripForecast', () => {
  it('keeps the typical days when the forecast for the near days is unavailable', async () => {
    // Days 10 to 20: 10-15 within the 16-day forecast, 16-20 past it.
    const model = await tripForecast(
      { db: {} as Db, weather: weather(() => Promise.resolve(null)) },
      1,
      trip(10, 20),
      TODAY,
    );
    expect(model).toMatchObject({
      kind: 'forecast',
      unavailable: true,
      days: [],
      fetchedAt: null,
      later: { day: addDays(TODAY, 16) },
    });
    if (model.kind !== 'forecast') throw new Error('not a forecast');
    expect(model.typical.map((day) => day.day)).toEqual(
      [16, 17, 18, 19, 20].map((n) => addDays(TODAY, n)),
    );

    const html = await renderToString(
      <TripWeather
        tripId={7}
        forecast={model}
        timeZone="America/New_York"
        now={new Date('2026-09-27T00:30:00Z')}
      />,
    );
    expect(html).toContain('data-forecast-unavailable');
    expect(html).toContain('No forecast for the destination right now.');
    expect(html.match(/data-typical-day="/g)).toHaveLength(5);
    // The near days failed; the later ones still arrive day by day.
    expect(html).toContain('the forecast arrives day by day');
  });

  it('is available once the forecast answers', async () => {
    const model = await tripForecast(
      {
        db: {} as Db,
        weather: weather(() =>
          Promise.resolve({
            forecast: { timeZone: 'America/New_York', days: [] },
            fetchedAt: new Date('2026-09-26T12:00:00Z'),
          }),
        ),
      },
      1,
      trip(10, 20),
      TODAY,
    );
    expect(model).toMatchObject({ kind: 'forecast', unavailable: false });
  });

  it('asks for no forecast, and so misses none, for a trip wholly past it', async () => {
    const forecastFor = vi.fn(() => Promise.resolve(null));
    const model = await tripForecast(
      { db: {} as Db, weather: weather(forecastFor) },
      1,
      trip(20, 22),
      TODAY,
    );
    expect(forecastFor).not.toHaveBeenCalled();
    expect(model).toMatchObject({ kind: 'forecast', unavailable: false });
  });

  /**
   * A day in the destination's own hours (#678): warm from 08:00 to 21:00,
   * freezing outside them, so a window read in New York's hours (22:00 to
   * 12:00 in Tokyo) would see the freezing night.
   */
  function localDay(day: string): DayForecast {
    const hours: HourForecast[] = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      feelsLike: hour >= 8 && hour < 22 ? 24 : -5,
      precipitationChance: 0,
      code: 0,
    }));
    return { day, code: 0, high: 25, low: -5, precipitationChance: 0, hours };
  }

  it("dresses a Tokyo trip day for Tokyo's 08:00-22:00, asked in Tokyo's zone", async () => {
    const tokyo = {
      latitude: 35.68,
      longitude: 139.69,
      timeZone: 'Asia/Tokyo',
    };
    const forecastFor = vi.fn((place: { timeZone: string }) =>
      Promise.resolve({
        forecast: {
          timeZone: place.timeZone,
          // Tokyo's forecast starts on its own today, home's tomorrow.
          days: [1, 2, 3].map((n) => localDay(addDays(TODAY, n))),
        },
        fetchedAt: new Date('2026-09-26T12:00:00Z'),
      }),
    );
    const model = await tripForecast(
      { db: {} as Db, weather: weather(forecastFor) },
      1,
      trip(0, 2, tokyo),
      TODAY,
    );
    expect(forecastFor).toHaveBeenCalledWith(tokyo, undefined, {
      row: undefined,
    });
    if (model.kind !== 'forecast') throw new Error('not a forecast');
    const [first, second] = model.days;
    expect(first.forecast.day).toBe(addDays(TODAY, 1));
    expect(first.needs).toMatchObject({
      window: { from: 8, to: 22 },
      feelsLike: { min: 24, max: 24 },
      layer: false,
    });
    expect(second.forecast.day).toBe(addDays(TODAY, 2));
    // Home's today is already over in Tokyo: no hole, its typical weather.
    expect(model.typical.map((day) => day.day)).toEqual([TODAY]);
  });

  it("reads a trip day past a Honolulu forecast's end from the normals, never a hole", async () => {
    const honolulu = {
      latitude: 21.31,
      longitude: -157.86,
      timeZone: 'Pacific/Honolulu',
    };
    // Honolulu is a day behind a Tokyo household: its sixteen days end on
    // home's fourteenth, so home's fifteenth is the forecast's to come.
    const model = await tripForecast(
      {
        db: {} as Db,
        weather: weather(() =>
          Promise.resolve({
            forecast: {
              timeZone: 'Pacific/Honolulu',
              days: Array.from({ length: 16 }, (_, n) =>
                localDay(addDays(TODAY, n - 1)),
              ),
            },
            fetchedAt: new Date('2026-09-26T12:00:00Z'),
          }),
        ),
      },
      1,
      trip(13, 15, honolulu),
      TODAY,
    );
    if (model.kind !== 'forecast') throw new Error('not a forecast');
    expect(model.days.map((day) => day.forecast.day)).toEqual([
      addDays(TODAY, 13),
      addDays(TODAY, 14),
    ]);
    expect(model.typical.map((day) => day.day)).toEqual([addDays(TODAY, 15)]);
    expect(model.later).toBeNull();
  });

  it("reads a trip located before #678 in the household's zone", async () => {
    const forecastFor = vi.fn(() => Promise.resolve(null));
    await tripForecast(
      { db: {} as Db, weather: weather(forecastFor) },
      1,
      trip(0, 1, { ...PLACE, timeZone: null }),
      TODAY,
    );
    expect(forecastFor).toHaveBeenCalledWith(
      { latitude: 30.27, longitude: -97.74, timeZone: 'America/New_York' },
      undefined,
      { row: undefined },
    );
  });
});
