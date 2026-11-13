import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { addDays, type IsoDate } from '../../src/calendar-date';
import { trip, userWeather } from '../../src/db/schema';
import { REFERENCE_ANCHOR } from '../../src/seed/simulate';
import {
  STUB_WEATHER_NOW,
  startWeatherStub,
  type WeatherStub,
} from '../support/weather-stub';
import { deviceToken, expectProblem } from './api';
import { createGarment } from './garments';
import { createTestApp, type TestApp } from './harness';

/**
 * Today and the weather on /api/v1 (#195a): each route its page twin's
 * read or writer (todayFor, userWeather, the settings' writers, the place
 * search, tripForecast, locateTrip). The forecast's own rules are
 * weather.spec.ts' and climate-normals.spec.ts'; who may reach a trip's
 * weather is authorization-trips'; what each costs is api-statements'.
 *
 * Date is pinned to the stub's day (STUB_WEATHER_NOW, noon in New York)
 * before the app boots, so the weather, and the branches it covers, are
 * the same every run.
 */

let t: TestApp;
let stub: WeatherStub;
let token: string;

const api = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
  as = token,
) => t.api(as, { method, url: `/api/v1${url}`, payload });

interface Weather {
  unit: string;
  temperatureOffset: number;
  home?: { name: string; latitude: number; longitude: number };
  here?: { latitude: number; longitude: number; locatedAt: string };
  source?: 'home' | 'here';
  fetchedAt?: string;
  days: {
    day: IsoDate;
    highC: number;
    outfit?: { occasion: string; needsLayer: boolean };
  }[];
}

// Fort Greene Park, precisely, as a phone or a geocoder would give it.
const PRECISE = { latitude: 40.689167, longitude: -73.975556 };
const ROUNDED = { latitude: 40.69, longitude: -73.98 };

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: STUB_WEATHER_NOW });
  stub = await startWeatherStub();
  t = await createTestApp(
    { WEATHER_ENABLED: 'true' },
    { weather: stub.options },
  );
  token = (await deviceToken(t)).token;
});

afterAll(async () => {
  await t?.cleanup();
  await stub?.close();
  vi.useRealTimers();
});

describe('the weather', () => {
  it('without a location: the settings, no forecast, nothing fetched', async () => {
    const res = await api('GET', '/weather');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      unit: 'fahrenheit',
      temperatureOffset: 0,
      days: [],
    });
    expect(stub.hits).toEqual([]);
  });

  it('sets the home rounded, then answers the week from the household day with what each asks', async () => {
    const set = await api('PUT', '/weather/home', {
      name: '  Fort Greene, New York, United States ',
      ...PRECISE,
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json()).toEqual({
      name: 'Fort Greene, New York, United States',
      ...ROUNDED,
    });
    expect(t.logs.messages('info', 'Web')).toContainEqual(
      expect.stringMatching(/^Weather home set by user \d+ \(API\)$/),
    );

    const week = (await api('GET', '/weather')).json<Weather>();
    expect(week).toMatchObject({
      source: 'home',
      home: { name: 'Fort Greene, New York, United States', ...ROUNDED },
      fetchedAt: STUB_WEATHER_NOW.toISOString(),
    });
    expect(week.days.map((d) => d.day)).toEqual(
      Array.from({ length: 7 }, (_, i) => addDays(REFERENCE_ANCHOR, i)),
    );
    expect(week.days[0].outfit?.occasion).toBe('all-day');
    // Only the rounded location ever left the server.
    expect(stub.hits.join('\n')).not.toContain('40.689');

    const evening = (
      await api(
        'GET',
        `/weather?from=${REFERENCE_ANCHOR}&to=${REFERENCE_ANCHOR}&occasion=evening`,
      )
    ).json<Weather>();
    expect(evening.days).toHaveLength(1);
    expect(evening.days[0].outfit?.occasion).toBe('evening');
    // Up to `to` alone; days past the forecast are left out.
    const upTo = (
      await api('GET', `/weather?to=${addDays(REFERENCE_ANCHOR, 2)}`)
    ).json<Weather>();
    expect(upTo.days.map((d) => d.day)).toEqual([
      REFERENCE_ANCHOR,
      addDays(REFERENCE_ANCHOR, 1),
      addDays(REFERENCE_ANCHOR, 2),
    ]);
    expect(
      (
        await api('GET', `/weather?from=${addDays(REFERENCE_ANCHOR, 20)}`)
      ).json<Weather>().days,
    ).toEqual([]);
  });

  it('refuses a backward range, one past 42 days, and any other occasion', async () => {
    for (const query of [
      `from=${REFERENCE_ANCHOR}&to=${addDays(REFERENCE_ANCHOR, -1)}`,
      `from=${REFERENCE_ANCHOR}&to=${addDays(REFERENCE_ANCHOR, 42)}`,
      'occasion=brunch',
    ]) {
      expectProblem(await api('GET', `/weather?${query}`), 400, 'validation');
    }
  });

  it("is the household's day, not UTC's, in the evening (#195a)", async () => {
    // 20:30 in New York: UTC is on tomorrow already.
    const evening = new Date(`${addDays(REFERENCE_ANCHOR, 1)}T00:30:00Z`);
    vi.setSystemTime(evening);
    try {
      const days = (await api('GET', '/weather')).json<Weather>().days;
      expect(days[0].day).toBe(REFERENCE_ANCHOR);
      expect(
        (await api('GET', '/today')).json<{ today: IsoDate }>().today,
      ).toBe(REFERENCE_ANCHOR);
      // The stale row's refresh, started by the ask, ends before the clock moves back.
      await t.weather!.settled();
    } finally {
      vi.setSystemTime(STUB_WEATHER_NOW);
    }
  });

  it("the phone's location stands in for home until cleared; the unit and the offset are settings", async () => {
    const here = await api('PUT', '/weather/here', PRECISE);
    expect(here.json()).toEqual({
      ...ROUNDED,
      locatedAt: STUB_WEATHER_NOW.toISOString(),
    });
    expect((await api('GET', '/weather')).json<Weather>()).toMatchObject({
      source: 'here',
      here: { ...ROUNDED },
    });
    expectProblem(
      await api('PUT', '/weather/here', { latitude: 91, longitude: 0 }),
      400,
      'validation',
    );
    expect((await api('DELETE', '/weather/here')).statusCode).toBe(204);
    expect((await api('GET', '/weather')).json<Weather>().source).toBe('home');

    expect(
      (await api('PUT', '/weather/unit', { unit: 'celsius' })).json(),
    ).toEqual({ unit: 'celsius' });
    expectProblem(
      await api('PUT', '/weather/unit', { unit: 'kelvin' }),
      400,
      'validation',
    );
    await api('POST', '/weather/feedback', { feeling: 'too-cold' });
    expect((await api('DELETE', '/weather/offset')).statusCode).toBe(204);
    const [row] = await t.db
      .select({
        unit: userWeather.temperatureUnit,
        offset: userWeather.temperatureOffset,
        hereAt: userWeather.hereLocatedAt,
      })
      .from(userWeather)
      .where(eq(userWeather.userId, t.owner.id));
    expect(row).toEqual({ unit: 'celsius', offset: 0, hereAt: null });
  });

  it('searches places through the server, never logging the name; a failed search is a 503', async () => {
    t.logs.clear();
    const res = await api('GET', '/weather/places?q=Brooklyn');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      data: [
        {
          label: 'Brooklyn, New York, United States',
          latitude: 40.65,
          longitude: -73.95,
        },
      ],
    });
    expect(t.logs.text()).not.toMatch(/brooklyn/i);
    expect((await api('GET', '/weather/places?q=Atlantis')).json()).toEqual({
      data: [],
    });
    expectProblem(await api('GET', '/weather/places?q=B'), 400, 'validation');
    stub.fail(true);
    try {
      expectProblem(
        await api('GET', '/weather/places?q=Brooklyn'),
        503,
        'busy',
      );
    } finally {
      stub.fail(false);
    }
  });

  it("keeps the page's location budget per user: the 11th set in a minute is a 429", async () => {
    const email = 'api-wanderer@example.com';
    await t.register(email);
    const wanderer = (await deviceToken(t, { email })).token;
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await api(
        'PUT',
        '/weather/here',
        { latitude: 40 + i / 10, longitude: -73.98 },
        wanderer,
      );
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(statuses[10]).toBe(429);
    // Someone else's count is their own.
    expect((await api('PUT', '/weather/here', PRECISE)).statusCode).toBe(200);
    expect((await api('DELETE', '/weather/here')).statusCode).toBe(204);
  });

  it('clears the home: no location, no forecast', async () => {
    expect((await api('DELETE', '/weather/home')).statusCode).toBe(204);
    const cleared = (await api('GET', '/weather')).json<Weather>();
    expect(cleared).not.toHaveProperty('source');
    expect(cleared.days).toEqual([]);
    // Set again for the sections below.
    await api('PUT', '/weather/home', { name: 'Fort Greene', ...PRECISE });
  });
});

describe('Today', () => {
  interface Today {
    today: IsoDate;
    weather?: Weather;
    rows: {
      kind: string;
      occasion: string;
      ideas?: { garments: { id: number }[] }[];
      entries?: { id: number; outfit: { id: number } }[];
      nextCursor?: string;
    }[];
  }

  it("is the page's model: the day's weather, then ideas whose cursor is Refresh on GET /ideas", async () => {
    for (let i = 0; i < 4; i += 1) {
      await createGarment(t, { name: `Tee ${i}`, category: 'tops' });
      await createGarment(t, { name: `Jeans ${i}`, category: 'bottoms' });
    }
    const res = await api('GET', '/today');
    expect(res.statusCode, res.body).toBe(200);
    const today = res.json<Today>();
    expect(today.today).toBe(REFERENCE_ANCHOR);
    expect(today.weather?.days.map((d) => d.day)).toEqual([REFERENCE_ANCHOR]);
    expect(today).not.toHaveProperty('muse');
    const [ideas] = today.rows;
    expect(ideas).toMatchObject({ kind: 'ideas', occasion: 'all-day' });
    expect(ideas.ideas).toHaveLength(3);

    const ids = (list: { garments: { id: number }[] }[]) =>
      list.map((idea) => idea.garments.map((g) => g.id));
    const six = (await api('GET', '/ideas?limit=6')).json<{
      data: { garments: { id: number }[] }[];
    }>().data;
    const refreshed = (
      await api('GET', `/ideas?limit=3&cursor=${ideas.nextCursor!}`)
    ).json<{ data: { garments: { id: number }[] }[] }>().data;
    expect([...ids(ideas.ideas!), ...ids(refreshed)]).toEqual(ids(six));
  });

  it('a planned all-day outfit replaces the ideas with its entry', async () => {
    const shirt = await createGarment(t, {
      name: 'Planned',
      category: 'shirt',
    });
    const made = await api('POST', '/outfits', {
      slots: [{ category: 'shirt', garmentId: shirt }],
    });
    expect(made.statusCode, made.body).toBe(201);
    const outfitId = made.json<{ id: number }>().id;
    const planned = await api('POST', '/calendar-entries', {
      outfitId,
      day: REFERENCE_ANCHOR,
      occasion: 'all-day',
    });
    expect(planned.statusCode, planned.body).toBe(201);
    const { rows } = (await api('GET', '/today')).json<Today>();
    expect(rows).toEqual([
      expect.objectContaining({
        kind: 'planned',
        occasion: 'all-day',
        entries: [
          expect.objectContaining({
            outfit: expect.objectContaining({ id: outfitId }),
          }),
        ],
      }),
    ]);
  });
});

describe("a trip's weather", () => {
  it('says the destination is not located, then gives its forecast once it is', async () => {
    const made = await api('POST', '/trips', {
      name: 'Weekend',
      startsOn: REFERENCE_ANCHOR,
      endsOn: addDays(REFERENCE_ANCHOR, 2),
    });
    expect(made.statusCode, made.body).toBe(201);
    const id = made.json<{ id: number }>().id;
    expect((await api('GET', `/trips/${id}/weather`)).json()).toEqual({
      status: 'no-location',
      days: [],
      typicalDays: [],
    });

    const located = await api('PUT', `/trips/${id}/destination`, {
      name: 'Brooklyn, New York, United States',
      latitude: 40.6501,
      longitude: -73.94958,
    });
    expect(located.json()).toEqual({
      name: 'Brooklyn, New York, United States',
      latitude: 40.65,
      longitude: -73.95,
    });
    const [row] = await t.db
      .select({ destination: trip.destination, latitude: trip.latitude })
      .from(trip)
      .where(eq(trip.id, id));
    expect(row).toEqual({
      destination: 'Brooklyn, New York, United States',
      latitude: 40.65,
    });
    const weather = (await api('GET', `/trips/${id}/weather`)).json<{
      status: string;
      forecastUnavailable: boolean;
      days: { day: IsoDate; outfit?: { occasion: string } }[];
      typicalDays: unknown[];
    }>();
    expect(weather).toMatchObject({
      status: 'forecast',
      forecastUnavailable: false,
      typicalDays: [],
    });
    expect(weather.days.map((d) => d.day)).toEqual([
      REFERENCE_ANCHOR,
      addDays(REFERENCE_ANCHOR, 1),
      addDays(REFERENCE_ANCHOR, 2),
    ]);
    expect(weather.days[0].outfit?.occasion).toBe('all-day');
  });
});
