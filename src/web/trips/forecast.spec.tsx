import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../../db/client';
import { type DayNormals, monthDayOf } from '../../weather/normals';
import { addDays } from '../calendar/calendar-date';
import { renderToString } from '../render';
import type { CachedNormals, WeatherService } from '../weather/service';
import { tripForecast } from './forecast';
import type { TripRow } from './queries';
import { TripWeather } from './weather';

vi.mock('../weather/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../weather/queries')>();
  return {
    ...actual,
    findWeatherSettings: vi.fn(() =>
      Promise.resolve(actual.NO_WEATHER_SETTINGS),
    ),
  };
});

/**
 * A trip whose near days the forecast reaches and whose far days it does
 * not, at a new destination where the forecast fails and the archive
 * answers (#112's sweep): the far days keep their typical weather, the near
 * ones say the forecast is unavailable, on the page and in the model
 * get_trip reads.
 */

const TODAY = '2026-09-26';
const PLACE = { latitude: 30.27, longitude: -97.74 };
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

function trip(from: number, to: number): TripRow {
  return {
    id: 7,
    name: 'Austin',
    destination: 'Austin, Texas, United States',
    startsOn: addDays(TODAY, from),
    endsOn: addDays(TODAY, to),
    notes: null,
    location: PLACE,
  };
}

function weather(forecast: WeatherService['forecastFor']): WeatherService {
  return {
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
});
