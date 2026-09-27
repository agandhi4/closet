import { eq } from 'drizzle-orm';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { trip, weatherNormals } from '../../src/db/schema';
import { monthDayOf } from '../../src/weather/normals';
import { displayTemperature } from '../../src/weather/temperature';
import { addDays } from '../../src/web/calendar/calendar-date';
import { startWeatherStub, type WeatherStub } from '../support/weather-stub';
import { createTestApp, type TestApp, unescapeHtml } from './harness';
import { createAccessToken, tool } from './mcp';
import { expectFragment, HX_FRAGMENT } from './pages';

/**
 * Climate normals (#14's "typical" days, for #10's trips): a trip's days
 * past the 16-day forecast show the destination's typical weather, labelled
 * as such, and ideas for them are judged against a typical day. Open-Meteo's
 * archive is the stand-in's (test/support/weather-stub.ts: the seed's
 * simulated New York days), reached through the real outbound fetcher, so
 * every request the app sends is in `stub.hits`. The normalization and the
 * typical day are unit-tested in src/weather/normals.spec.ts.
 *
 * The clock is pinned (Date only) to 00:30 UTC on Sunday 27 September 2026,
 * Saturday the 26th in New York (APP_TIMEZONE): the normals average
 * 2016-2025, and the forecast reaches 11 October.
 */

const NOW = new Date('2026-09-27T00:30:00Z');
const TODAY = '2026-09-26';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const AUSTIN = {
  name: 'Austin, Texas, United States',
  latitude: '30.26715',
  longitude: '-97.74306',
};
const SPRINGFIELD = {
  name: 'Springfield, Illinois, United States',
  latitude: '39.80172',
  longitude: '-89.64371',
};

type Fields = Record<string, string | string[]>;

function at(offsetMs: number): void {
  vi.setSystemTime(new Date(NOW.getTime() + offsetMs));
}

function hitsOf(stub: WeatherStub, path: string): URLSearchParams[] {
  return stub.hits
    .filter((hit) => hit.startsWith(`${path}?`))
    .map((hit) => new URLSearchParams(hit.slice(hit.indexOf('?') + 1)));
}

describe('climate normals', () => {
  let stub: WeatherStub;
  let t: TestApp;
  let jacket: number;

  const post = (url: string, fields: Fields) => {
    const body = new URLSearchParams();
    for (const [name, value] of Object.entries(fields)) {
      for (const item of [value].flat()) body.append(name, item);
    }
    return t.inject({
      method: 'POST',
      url,
      payload: body.toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
  };
  const get = (url: string) => t.inject({ method: 'GET', url });
  const archiveHits = () => hitsOf(stub, '/v1/archive');

  const garment = async (fields: Fields): Promise<number> => {
    const res = await post('/wardrobe', { props: '1', care: '1', ...fields });
    expect(res.statusCode).toBe(302);
    return Number(
      /^\/wardrobe\/(\d+)\?/.exec(String(res.headers.location))![1],
    );
  };

  /** A trip over the days `from` to `to` after today, at `place` when given. */
  const newTrip = async (
    from: number,
    to: number,
    place?: typeof AUSTIN,
  ): Promise<number> => {
    const res = await post('/trips', {
      name: 'Away',
      destination: place ? place.name : '',
      startsOn: addDays(TODAY, from),
      endsOn: addDays(TODAY, to),
      notes: '',
    });
    expect(res.statusCode, res.body).toBe(303);
    const id = Number(/^\/trips\/(\d+)/.exec(String(res.headers.location))![1]);
    if (place) {
      expect((await post(`/trips/${id}/destination`, place)).statusCode).toBe(
        303,
      );
    }
    return id;
  };

  const tripWeather = async (id: number) => {
    const res = await t.inject({
      method: 'GET',
      url: `/trips/${id}/weather`,
      headers: HX_FRAGMENT,
    });
    expectFragment(res);
    return unescapeHtml(res.body);
  };

  const typicalDays = (html: string) =>
    [...html.matchAll(/data-typical-day="([\d-]+)"/g)].map((m) => m[1]);

  beforeAll(async () => {
    stub = await startWeatherStub();
    t = await createTestApp(
      { WEATHER_ENABLED: 'true' },
      { weather: stub.options },
    );
    await garment({ name: 'White tee', category: 'tops', color: ['white'] });
    await garment({ name: 'Raw jeans', category: 'bottoms', color: ['blue'] });
    await garment({
      name: 'White sneakers',
      category: 'footwear',
      color: ['white'],
    });
    jacket = await garment({
      name: 'Denim jacket',
      category: 'outerwear',
      color: ['blue'],
    });
  });

  afterAll(async () => {
    await t.cleanup();
    await stub.close();
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    stub.fail(false);
  });

  it('shows the typical weather of days past the forecast, labelled, from the archive at the rounded location', async () => {
    t.logs.clear();
    const id = await newTrip(30, 32, AUSTIN);
    const html = await tripWeather(id);
    const days = [30, 31, 32].map((n) => addDays(TODAY, n));
    expect(typicalDays(html)).toEqual(days);
    expect(html).toContain('not a forecast');
    expect(html).toContain('arrives on');

    // One archive request: ten whole years at the rounded location, in the
    // household's zone, nothing about the user. The trip starts past the
    // forecast, so no forecast is asked for.
    const [sent, ...more] = archiveHits();
    expect(more).toEqual([]);
    expect(Object.fromEntries(sent)).toMatchObject({
      latitude: '30.27',
      longitude: '-97.74',
      start_date: '2016-01-01',
      end_date: '2025-12-31',
      timezone: 'America/New_York',
    });
    expect(hitsOf(stub, '/v1/forecast')).toEqual([]);

    // The cached row: every calendar day, no user id.
    const [row] = await t.db.select().from(weatherNormals);
    expect(row).toMatchObject({
      latitude: 30.27,
      longitude: -97.74,
      fetchedAt: NOW,
      attemptedAt: NOW,
    });
    expect(row.normals?.years).toEqual({ first: 2016, last: 2025 });
    expect(Object.keys(row.normals!.days)).toHaveLength(366);

    // Each day reads its own normal, in the user's unit (°F by default).
    for (const day of days) {
      const normal = row.normals!.days[monthDayOf(day)];
      expect(html).toContain(
        `Typically ${displayTemperature(normal.low, 'fahrenheit')}–${displayTemperature(normal.high, 'fahrenheit')} °F, ${normal.rainChance}% rain chance`,
      );
      expect(html).toContain(`/outfits/ideas?for=trip:${id}:${day}`);
    }
    expect(t.logs.messages('info', 'Weather')).toEqual([
      expect.stringMatching(
        /^Climate normals for 30\.27,-97\.74: 366 days from 2016-2025 in \d+ ms$/,
      ),
    ]);
  });

  it('shows the forecast for the days it reaches and the typical weather after', async () => {
    const id = await newTrip(14, 18, AUSTIN);
    const html = await tripWeather(id);
    const forecast = [...html.matchAll(/data-weather-day="([\d-]+)"/g)].map(
      (m) => m[1],
    );
    expect(forecast).toEqual([14, 15].map((n) => addDays(TODAY, n)));
    expect(typicalDays(html)).toEqual(
      [16, 17, 18].map((n) => addDays(TODAY, n)),
    );
    // Austin's normals were cached by the first trip: nothing new asked.
    expect(archiveHits()).toHaveLength(1);
  });

  it('asks the archive once per location for simultaneous pages, and again only after 30 days', async () => {
    const id = await newTrip(200, 202, SPRINGFIELD);
    const before = archiveHits().length;
    const pages = await Promise.all([
      tripWeather(id),
      tripWeather(id),
      tripWeather(id),
    ]);
    for (const html of pages) expect(typicalDays(html)).toHaveLength(3);
    expect(archiveHits()).toHaveLength(before + 1);

    at(29 * DAY);
    await tripWeather(id);
    expect(archiveHits()).toHaveLength(before + 1);

    at(31 * DAY);
    await tripWeather(id);
    expect(archiveHits()).toHaveLength(before + 2);
    const [row] = await t.db
      .select()
      .from(weatherNormals)
      .where(eq(weatherNormals.latitude, 39.8));
    expect(row.fetchedAt).toEqual(new Date(NOW.getTime() + 31 * DAY));
  });

  it('keeps the last good normals when the archive fails, and waits before asking again', async () => {
    const id = await newTrip(200, 201, AUSTIN);
    stub.fail(true);
    t.logs.clear();
    const before = archiveHits().length;
    at(40 * DAY);
    const html = await tripWeather(id);
    expect(typicalDays(html)).toHaveLength(2);
    expect(archiveHits()).toHaveLength(before + 1);
    expect(t.logs.messages('warn', 'Weather')).toEqual([
      expect.stringMatching(
        /^Climate normals for 30\.27,-97\.74 failed \(http-status\) after \d+ ms; serving the one from 2026-09-27T00:30:00\.000Z$/,
      ),
    ]);

    at(40 * DAY + 9 * MINUTE);
    await tripWeather(id);
    expect(archiveHits()).toHaveLength(before + 1);

    stub.fail(false);
    at(40 * DAY + 11 * MINUTE);
    await tripWeather(id);
    expect(archiveHits()).toHaveLength(before + 2);
  });

  it("takes the years from the household's today: New Year's Eve in New York is still 2026", async () => {
    // 1 January 2027 in UTC, 31 December 2026 in New York (today.spec.ts's
    // instant): the last whole year is 2025, not 2026.
    vi.setSystemTime(new Date('2027-01-01T04:30:00Z'));
    const id = await newTrip(160, 161, {
      name: 'Fort Greene, New York, United States',
      latitude: '40.68982',
      longitude: '-73.97625',
    });
    await tripWeather(id);
    const [sent] = archiveHits().filter(
      (params) => params.get('latitude') === '40.69',
    );
    expect(sent.get('start_date')).toBe('2016-01-01');
    expect(sent.get('end_date')).toBe('2025-12-31');
  });

  it('shows no typical days for a place the archive never answered, and still says when the forecast arrives', async () => {
    stub.fail(true);
    const id = await newTrip(60, 61, {
      name: 'Brooklyn, New York, United States',
      latitude: '40.6501',
      longitude: '-73.94958',
    });
    const html = await tripWeather(id);
    expect(typicalDays(html)).toEqual([]);
    expect(html).toContain('arrives on');
    const [row] = await t.db
      .select()
      .from(weatherNormals)
      .where(eq(weatherNormals.latitude, 40.65));
    expect(row).toMatchObject({ normals: null, fetchedAt: null });
  });

  it('judges ideas for a far trip day against the typical day, never home or nothing', async () => {
    const id = await newTrip(30, 31, AUSTIN);
    const day = addDays(TODAY, 30);
    t.logs.clear();
    const res = await get(`/outfits/ideas?for=trip:${id}:${day}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('data-ideas-weather="typical"');
    expect(res.body).toMatch(
      /Typically feels -?\d+–-?\d+ °F \(not a forecast\)/,
    );
    // A late-October New York day swings enough to ask for a layer, so the
    // ideas bring the jacket; without weather no layer is ever drawn.
    const ideas = [...res.body.matchAll(/data-idea="([\d,]+)"/g)].map((m) =>
      m[1].split(',').map(Number),
    );
    expect(ideas.length).toBeGreaterThan(0);
    expect(ideas.every((garments) => garments.includes(jacket))).toBe(true);
    expect(res.body).toContain('Fits the typical weather');
    expect(t.logs.messages('debug', 'Web')).toContainEqual(
      expect.stringMatching(/, trip \d+, typical weather\) in \d+ ms$/),
    );

    // The same day of a trip without a located destination has no weather.
    const unlocated = await newTrip(30, 31);
    const bare = await get(`/outfits/ideas?for=trip:${unlocated}:${day}`);
    expect(bare.body).not.toContain('data-ideas-weather');
    const bareIdeas = [...bare.body.matchAll(/data-idea="([\d,]+)"/g)].map(
      (m) => m[1].split(',').map(Number),
    );
    expect(bareIdeas.some((garments) => garments.includes(jacket))).toBe(false);
  });

  it('never gives Today, the gallery or the week typical weather', async () => {
    expect(
      (
        await t.inject({
          method: 'POST',
          url: '/weather/home',
          headers: {
            ...HX_FRAGMENT,
            'content-type': 'application/x-www-form-urlencoded',
          },
          payload: new URLSearchParams({
            name: 'Fort Greene',
            latitude: '40.68982',
            longitude: '-73.97625',
          }).toString(),
        })
      ).statusCode,
    ).toBe(200);
    const before = archiveHits().length;
    expect((await get('/')).statusCode).toBe(200);
    const far = await get(`/outfits/ideas?for=day:${addDays(TODAY, 40)}`);
    expect(far.body).not.toContain('data-ideas-weather');
    expect((await post('/calendar/plan-week', {})).statusCode).toBe(303);
    expect(archiveHits()).toHaveLength(before);
  });

  it('gives get_trip the typical days, marked typical', async () => {
    const id = await newTrip(14, 17, AUSTIN);
    const token = await createAccessToken(t);
    const read = await tool<{
      weather: {
        days: { day: string }[];
        laterDays: { from: string; forecastArrives: string };
        typicalDays: {
          day: string;
          typical: boolean;
          highC: number;
          lowC: number;
          rainChance: number;
          outfit: { occasion: string; needsLayer: boolean } | null;
        }[];
      };
    }>(t, token, 'get_trip', { tripId: id });
    expect(read.weather.days.map((d) => d.day)).toEqual(
      [14, 15].map((n) => addDays(TODAY, n)),
    );
    expect(read.weather.laterDays).toEqual({
      from: addDays(TODAY, 16),
      forecastArrives: addDays(TODAY, 1),
    });
    const [row] = await t.db
      .select()
      .from(weatherNormals)
      .where(eq(weatherNormals.latitude, 30.27));
    expect(read.weather.typicalDays).toEqual(
      [16, 17].map((n) => {
        const day = addDays(TODAY, n);
        const normal = row.normals!.days[monthDayOf(day)];
        return expect.objectContaining({
          day,
          typical: true,
          highC: normal.high,
          lowC: normal.low,
          rainChance: normal.rainChance,
          outfit: expect.objectContaining({ occasion: 'all-day' }),
        });
      }),
    );
  });
});

describe('climate normals with WEATHER_ENABLED=false', () => {
  let stub: WeatherStub;
  let t: TestApp;

  beforeAll(async () => {
    stub = await startWeatherStub();
    // The stand-in is wired, so a fetch would show in its hits.
    t = await createTestApp({}, { weather: stub.options });
  });

  afterAll(async () => {
    await t.cleanup();
    await stub.close();
  });

  it('fetches nothing for a far trip day, even one located before weather went off', async () => {
    const today = t.today();
    const res = await t.inject({
      method: 'POST',
      url: '/trips',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        name: 'Away',
        destination: 'Austin',
        startsOn: addDays(today, 30),
        endsOn: addDays(today, 31),
        notes: '',
      }).toString(),
    });
    expect(res.statusCode).toBe(303);
    const id = Number(/^\/trips\/(\d+)/.exec(String(res.headers.location))![1]);
    await t.db
      .update(trip)
      .set({ latitude: 30.27, longitude: -97.74 })
      .where(eq(trip.id, id));

    const weather = await t.inject({
      method: 'GET',
      url: `/trips/${id}/weather`,
      headers: HX_FRAGMENT,
    });
    expect(weather.statusCode).toBe(404);
    const ideas = await t.inject({
      method: 'GET',
      url: `/outfits/ideas?for=trip:${id}:${addDays(today, 30)}`,
    });
    expect(ideas.statusCode).toBe(200);
    expect(ideas.body).not.toContain('data-ideas-weather');
    const token = await createAccessToken(t);
    const read = await tool<{ weather?: unknown }>(t, token, 'get_trip', {
      tripId: id,
    });
    expect(read.weather).toBeUndefined();

    expect(stub.hits).toEqual([]);
    expect(await t.db.select().from(weatherNormals)).toEqual([]);
  });
});
