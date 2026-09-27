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
import { user, userWeather, weatherForecast } from '../../src/db/schema';
import { forecastDayOf, weatherFor } from '../../src/seed/weather';
import { displayTemperature } from '../../src/weather/temperature';
import { createOutfit } from '../../src/web/outfits/queries';
import { createTestApp, hasText, type TestApp, unescapeHtml } from './harness';
import { callTool, createAccessToken, mcpRequest, tool } from './mcp';
import { expectFragment, expectFullPage, HX_FRAGMENT } from './pages';
import { startWeatherStub, type WeatherStub } from '../support/weather-stub';

/**
 * Weather (#14): the settings a user keeps, the forecast the server fetches
 * and caches for their rounded location, and what the pages load. Open-Meteo
 * is the stand-in (test/support/weather-stub.ts), reached through the real
 * outbound fetcher, so every request the app sends is in `stub.hits`.
 *
 * The clock is pinned (Date only; timers stay real) to 00:30 UTC on Sunday
 * 27 September 2026, which is still Saturday the 26th, 8:30 pm, in New York
 * (APP_TIMEZONE): every day and hour below is the household's.
 */

const NOW = new Date('2026-09-27T00:30:00Z');
const TODAY = '2026-09-26';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// Fort Greene Park, precisely, as a phone or a geocoder would give it.
const PRECISE = { latitude: '40.689167', longitude: '-73.975556' };
const ROUNDED = { latitude: 40.69, longitude: -73.98 };

function forecastHits(stub: WeatherStub): URLSearchParams[] {
  return stub.hits
    .filter((hit) => hit.startsWith('/v1/forecast?'))
    .map((hit) => new URLSearchParams(hit.slice(hit.indexOf('?') + 1)));
}

function at(offsetMs: number): void {
  vi.setSystemTime(new Date(NOW.getTime() + offsetMs));
}

/**
 * Waits for the background refresh (#114) an ask started at `offsetMs` to
 * record its outcome: a stale forecast is served at once and refreshed after
 * the answer, so a spec that counts fetches or reads the next answer waits
 * for the row's attempt first. By then the refresh has finished: the row is
 * saved (or the failure recorded) as its last step.
 */
async function refreshed(t: TestApp, offsetMs: number): Promise<void> {
  // A loop on real timers, not vi.waitFor: with fake timers installed,
  // vi.waitFor advances the faked clock on every try, and the refresh would
  // record a later instant than the one the spec asked at.
  const expected = new Date(NOW.getTime() + offsetMs);
  for (let tries = 0; ; tries += 1) {
    const [row] = await t.db
      .select({ attemptedAt: weatherForecast.attemptedAt })
      .from(weatherForecast)
      .where(eq(weatherForecast.latitude, ROUNDED.latitude));
    if (row.attemptedAt.getTime() === expected.getTime() || tries === 500) {
      expect(row.attemptedAt).toEqual(expected);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function toolNamesOf(t: TestApp, token: string): Promise<string[]> {
  const res = await mcpRequest(t, token, 'tools/list');
  return res
    .json<{ result: { tools: { name: string }[] } }>()
    .result.tools.map((listed) => listed.name);
}

const form = (fields: Record<string, string>) => ({
  headers: {
    ...HX_FRAGMENT,
    'content-type': 'application/x-www-form-urlencoded',
  },
  payload: new URLSearchParams(fields).toString(),
});

describe('weather', () => {
  let stub: WeatherStub;
  let t: TestApp;

  beforeAll(async () => {
    stub = await startWeatherStub();
    t = await createTestApp(
      { WEATHER_ENABLED: 'true' },
      { weather: stub.options },
    );
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

  const summary = (query = '') =>
    t.inject({
      method: 'GET',
      url: `/weather/summary${query}`,
      headers: HX_FRAGMENT,
    });

  describe('before a location is set', () => {
    it('asks for one instead of fetching', async () => {
      const res = await summary();
      expect(res.statusCode).toBe(200);
      expectFragment(res);
      expect(res.body).toContain('href="/auth/profile#weather"');
      expect(stub.hits).toEqual([]);
    });

    it('offers the settings on the profile', async () => {
      const res = await t.inject({ method: 'GET', url: '/auth/profile' });
      expectFullPage(res);
      expect(res.body).toContain('id="weather"');
      expect(res.body).toContain('hx-get="/weather/places"');
      expect(res.body).toContain("import { initLocate } from 'locate'");
    });
  });

  describe('the city search', () => {
    it('answers places, rounded, and logs neither the query nor the user', async () => {
      t.logs.clear();
      const res = await t.inject({
        method: 'GET',
        url: '/weather/places?q=Brooklyn',
        headers: HX_FRAGMENT,
      });
      expect(res.statusCode).toBe(200);
      expectFragment(res);
      const body = unescapeHtml(res.body);
      expect(body).toContain('Brooklyn, New York, United States');
      expect(body).toContain('name="latitude" value="40.65"');
      expect(body).toContain('name="longitude" value="-73.95"');
      expect(stub.hits.at(-1)).toMatch(/^\/v1\/search\?name=Brooklyn&/);
      expect(t.logs.messages('info', 'Weather')).toEqual([
        expect.stringMatching(/^Place search: 1 result\(s\) in \d+ ms$/),
      ]);
      // The request line names the route, not the typed city.
      expect(t.logs.text()).not.toMatch(/brooklyn/i);
    });

    it('says so when nothing matches, or the search fails', async () => {
      const none = await t.inject({
        method: 'GET',
        url: '/weather/places?q=Atlantis',
        headers: HX_FRAGMENT,
      });
      expect(none.body).toContain('No place by that name.');
      stub.fail(true);
      const failed = await t.inject({
        method: 'GET',
        url: '/weather/places?q=Brooklyn',
        headers: HX_FRAGMENT,
      });
      expect(failed.statusCode).toBe(200);
      expect(failed.body).toContain('The search did not work just now.');
    });

    it('refuses a query too short or too long', async () => {
      for (const q of ['B', 'x'.repeat(101)]) {
        const res = await t.inject({
          method: 'GET',
          url: `/weather/places?q=${q}`,
          headers: HX_FRAGMENT,
        });
        expect(res.statusCode).toBe(400);
      }
    });
  });

  describe('with a home city', () => {
    beforeAll(async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      at(0);
      const res = await t.inject({
        method: 'POST',
        url: '/weather/home',
        ...form({ name: 'Fort Greene, New York, United States', ...PRECISE }),
      });
      expect(res.statusCode).toBe(200);
      vi.useRealTimers();
    });

    it('stores it rounded, and answers the section', async () => {
      const [row] = await t.db
        .select()
        .from(userWeather)
        .where(eq(userWeather.userId, t.owner.id));
      expect(row).toMatchObject({
        homeName: 'Fort Greene, New York, United States',
        homeLatitude: ROUNDED.latitude,
        homeLongitude: ROUNDED.longitude,
        hereLatitude: null,
      });
      const res = await t.inject({ method: 'GET', url: '/auth/profile' });
      expect(res.body).toContain('Home: Fort Greene, New York, United States');
    });

    it("shows today's weather, New York's today, fetched with the rounded location only", async () => {
      t.logs.clear();
      const before = forecastHits(stub).length;
      const res = await summary();
      expect(res.statusCode).toBe(200);
      expectFragment(res);

      const [sent] = forecastHits(stub).slice(before);
      expect([...sent.keys()].sort()).toEqual([
        'daily',
        'forecast_days',
        'hourly',
        'latitude',
        'longitude',
        'timezone',
      ]);
      expect(sent.get('latitude')).toBe('40.69');
      expect(sent.get('longitude')).toBe('-73.98');
      expect(sent.get('timezone')).toBe('America/New_York');
      expect(sent.get('forecast_days')).toBe('16');

      const day = forecastDayOf('demo', weatherFor('demo', TODAY, 1)[0]);
      const body = unescapeHtml(res.body);
      expect(body).toContain('id="weather-line"');
      expect(body).toContain(
        // No unit chosen: the default, °F.
        `${displayTemperature(day.low, 'fahrenheit')}–${displayTemperature(day.high, 'fahrenheit')} °F`,
      );
      expect(body).toContain('Fort Greene · as of 8:30 PM');

      // The log names the rounded location, never the user; the fetcher's
      // line names the host, never the query.
      expect(t.logs.messages('info', 'Weather')).toEqual([
        'Forecast for 40.69,-73.98: refreshing; none kept, the ask waits',
        expect.stringMatching(
          /^Forecast for 40\.69,-73\.98: 16 days in \d+ ms$/,
        ),
      ]);
      expect(t.logs.messages('info', 'OutboundFetch')).toEqual([
        expect.stringMatching(/^Fetched json from 127\.0\.0\.2: \d+ bytes/),
      ]);
      const text = t.logs.text();
      expect(text).not.toContain('latitude=');
      expect(text).not.toContain('40.689');
      for (const record of t.logs.records) {
        if (record.msg.includes('40.69')) {
          expect(record.msg).not.toMatch(/user|owner@/i);
        }
      }

      const [cached] = await t.db.select().from(weatherForecast);
      expect(cached).toMatchObject({
        latitude: 40.69,
        longitude: -73.98,
        fetchedAt: NOW,
        attemptedAt: NOW,
      });
      expect(cached.forecast?.days[0].day).toBe(TODAY);
      expect(cached.forecast?.days).toHaveLength(16);
    });

    it('fetches once an hour per location, in the background, once for simultaneous asks', async () => {
      const before = forecastHits(stub).length;
      at(59 * MINUTE);
      await summary();
      expect(forecastHits(stub)).toHaveLength(before);

      // An hour old: every ask is served the cached forecast at once, and
      // one refresh runs behind them.
      t.logs.clear();
      at(61 * MINUTE);
      const answers = await Promise.all([summary(), summary(), summary()]);
      expect(answers.map((res) => res.statusCode)).toEqual([200, 200, 200]);
      for (const res of answers) {
        expect(res.body).toContain('as of 8:30 PM');
      }
      await refreshed(t, 61 * MINUTE);
      expect(forecastHits(stub)).toHaveLength(before + 1);
      expect(t.logs.messages('info', 'Weather')).toEqual([
        'Forecast for 40.69,-73.98: refreshing; the one from 2026-09-27T00:30:00.000Z kept meanwhile',
        expect.stringMatching(
          /^Forecast for 40\.69,-73\.98: 16 days in \d+ ms$/,
        ),
      ]);

      // The next ask gets the refreshed forecast, and fetches nothing.
      const next = await summary();
      expect(next.body).toContain('as of 9:31 PM');
      expect(forecastHits(stub)).toHaveLength(before + 1);
    });

    it('keeps the last good forecast when Open-Meteo fails, and waits before asking again', async () => {
      stub.fail(true);
      t.logs.clear();
      const before = forecastHits(stub).length;
      at(3 * HOUR);
      const res = await summary();
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('as of 9:31 PM');
      await refreshed(t, 3 * HOUR);
      expect(forecastHits(stub)).toHaveLength(before + 1);
      expect(t.logs.messages('warn', 'Weather')).toEqual([
        expect.stringMatching(
          /^Forecast for 40\.69,-73\.98 failed \(http-status\) after \d+ ms; serving the one from 2026-09-27T01:31:00\.000Z$/,
        ),
      ]);

      // The failed refresh changed nothing the page shows.
      expect((await summary()).body).toBe(res.body);

      at(3 * HOUR + 9 * MINUTE);
      await summary();
      expect(forecastHits(stub)).toHaveLength(before + 1);

      stub.fail(false);
      at(3 * HOUR + 11 * MINUTE);
      const stale = await summary();
      expect(stale.body).toContain('as of 9:31 PM');
      await refreshed(t, 3 * HOUR + 11 * MINUTE);
      expect(forecastHits(stub)).toHaveLength(before + 2);
      expect((await summary()).body).toContain('as of 11:41 PM');
    });

    it("gives the calendar's days their chips, from the household's today", async () => {
      // The week of the 20th: only Saturday the 26th is in the forecast,
      // though it is the 27th in UTC.
      const past = unescapeHtml(
        (await summary('?from=2026-09-20&to=2026-09-26')).body,
      );
      expect(past).toContain('id="weather-line"');
      expect(past.match(/id="weather-day-[\d-]+"/g)).toEqual([
        'id="weather-day-2026-09-26"',
      ]);
      expect(past).toContain('hx-swap-oob="true"');

      const next = unescapeHtml(
        (await summary('?from=2026-09-27&to=2026-10-03')).body,
      );
      expect(next.match(/id="weather-day-[\d-]+"/g)).toHaveLength(7);

      // Sixteen days from the 26th end on 11 October.
      const far = unescapeHtml(
        (await summary('?from=2026-10-11&to=2026-10-17')).body,
      );
      expect(far.match(/id="weather-day-[\d-]+"/g)).toEqual([
        'id="weather-day-2026-10-11"',
      ]);
    });

    it('refuses a malformed range', async () => {
      for (const query of [
        '?from=2026-09-20',
        '?from=2026-09-27&to=2026-09-20',
        '?from=2026-09-01&to=2026-12-01',
        '?from=2026-02-30&to=2026-03-01',
      ]) {
        expect((await summary(query)).statusCode).toBe(400);
      }
    });

    it('puts the slots on the wardrobe and the calendar, never in the pages themselves', async () => {
      const calendar = await t.inject({
        method: 'GET',
        url: '/calendar?week=2026-09-20',
      });
      expectFullPage(calendar);
      const body = unescapeHtml(calendar.body);
      expect(body).toContain(
        'hx-get="/weather/summary?from=2026-09-20&to=2026-09-26"',
      );
      expect(body).toContain('id="weather-day-2026-09-20"');
      expect(body).not.toContain('°C');

      const wardrobe = await t.inject({ method: 'GET', url: '/wardrobe' });
      expectFullPage(wardrobe);
      expect(wardrobe.body).toContain('hx-get="/weather/summary"');
      // Filtering swaps #wardrobe-main alone; the line sits outside it.
      const fragment = await t.inject({
        method: 'GET',
        url: '/wardrobe?category=tops',
        headers: HX_FRAGMENT,
      });
      expect(fragment.body).not.toContain('/weather/summary');
      const selecting = await t.inject({
        method: 'GET',
        url: '/wardrobe?select=1',
      });
      expect(selecting.body).not.toContain('/weather/summary');
    });

    it('reads in °F when the user asks', async () => {
      const res = await t.inject({
        method: 'POST',
        url: '/weather/unit',
        ...form({ unit: 'fahrenheit' }),
      });
      expect(res.statusCode).toBe(200);
      // The unit's status line and the offset, which reads in the unit, out
      // of band; never the unit's own form (src/web/autosave.tsx).
      expect(hasText(res.body, 'Saved')).toBe(true);
      expect(res.body).toMatch(/id="weather-offset"[^>]*hx-swap-oob="true"/);
      expect(res.body).not.toContain('name="unit"');
      const profile = await t.inject({ method: 'GET', url: '/auth/profile' });
      expect(profile.body).toMatch(/value="fahrenheit"[^>]*\schecked/);
      const day = forecastDayOf('demo', weatherFor('demo', TODAY, 1)[0]);
      expect(unescapeHtml((await summary()).body)).toContain(
        `${displayTemperature(day.low, 'fahrenheit')}–${displayTemperature(day.high, 'fahrenheit')} °F`,
      );
      await t.inject({
        method: 'POST',
        url: '/weather/unit',
        ...form({ unit: 'celsius' }),
      });
    });
  });

  describe("the phone's location", () => {
    it('stands in for home, rounded, for twelve hours', async () => {
      const res = await t.inject({
        method: 'POST',
        url: '/weather/here',
        ...form({ latitude: '40.712776', longitude: '-74.005974' }),
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Using your location from 8:30 PM');
      // The location part only: the section holds the unit's autosave form,
      // which no other answer may replace (src/web/autosave.tsx).
      expect(res.body).toContain('id="weather-location"');
      expect(res.body).not.toContain('name="unit"');
      const [row] = await t.db
        .select()
        .from(userWeather)
        .where(eq(userWeather.userId, t.owner.id));
      expect(row).toMatchObject({
        hereLatitude: 40.71,
        hereLongitude: -74.01,
        hereLocatedAt: NOW,
      });

      const line = unescapeHtml((await summary()).body);
      expect(line).toContain('Near you');
      expect(forecastHits(stub).at(-1)?.get('latitude')).toBe('40.71');

      // Home's forecast is stale by now: served, and refreshed behind it.
      at(13 * HOUR);
      const later = unescapeHtml((await summary()).body);
      expect(later).toContain('Fort Greene');
      await refreshed(t, 13 * HOUR);
      expect(forecastHits(stub).at(-1)?.get('latitude')).toBe('40.69');
    });

    it('refuses a position off the globe and stores nothing', async () => {
      const res = await t.inject({
        method: 'POST',
        url: '/weather/here',
        ...form({ latitude: '91', longitude: '0' }),
      });
      expect(res.statusCode).toBe(400);
      const [row] = await t.db
        .select()
        .from(userWeather)
        .where(eq(userWeather.userId, t.owner.id));
      expect(row.hereLatitude).toBe(40.71);
    });

    it('is forgotten on Stop', async () => {
      await t.inject({
        method: 'POST',
        url: '/weather/here/clear',
        ...form({}),
      });
      const [row] = await t.db
        .select()
        .from(userWeather)
        .where(eq(userWeather.userId, t.owner.id));
      expect(row).toMatchObject({
        hereLatitude: null,
        hereLongitude: null,
        hereLocatedAt: null,
        homeLatitude: 40.69,
      });
    });
  });

  describe('the personal offset', () => {
    const feedback = (feeling: string) =>
      t.inject({
        method: 'POST',
        url: '/weather/feedback',
        ...form({ feeling }),
      });
    const offset = async () =>
      (
        await t.db
          .select()
          .from(userWeather)
          .where(eq(userWeather.userId, t.owner.id))
      )[0].temperatureOffset;

    it('moves half a degree per feedback, capped at ±5', async () => {
      const cold = await feedback('too-cold');
      expect(cold.body).toContain(
        'You run cold: outfits are matched as if it were 0.5° colder.',
      );
      // The offset part only, never the unit's autosave form.
      expect(cold.body).toContain('id="weather-offset"');
      expect(cold.body).not.toContain('name="unit"');
      expect(await offset()).toBe(-0.5);
      await Promise.all(Array.from({ length: 12 }, () => feedback('too-warm')));
      expect(await offset()).toBe(5);
      const capped = await feedback('too-warm');
      expect(capped.body).toContain('as if it were 5° warmer');
      expect(await offset()).toBe(5);
      await t.inject({
        method: 'POST',
        url: '/weather/offset/reset',
        ...form({}),
      });
      expect(await offset()).toBe(0);
    });

    it('refuses any other feeling', async () => {
      expect((await feedback('just-right')).statusCode).toBe(400);
    });

    it('answers a plain post with the profile', async () => {
      const res = await t.inject({
        method: 'POST',
        url: '/weather/feedback',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'feeling=too-warm',
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/auth/profile#weather');
    });
  });

  describe('MCP', () => {
    let token: string;

    beforeAll(async () => {
      token = await createAccessToken(t);
    });

    // The next morning: the clock only moves forward from the specs above.
    beforeEach(() => {
      at(14 * HOUR);
    });

    it('lists get_weather and answers the forecast with what it asks of an outfit', async () => {
      expect(await toolNamesOf(t, token)).toContain('get_weather');

      const answer = await tool<{
        today: string;
        location: { name: string; source: string };
        days: {
          day: string;
          outfit: { occasion: string; hours: object; torsoWarmth: number };
        }[];
      }>(t, token, 'get_weather', { occasion: 'evening' });
      expect(answer.today).toBe('2026-09-27');
      expect(answer.location).toEqual({
        name: 'Fort Greene, New York, United States',
        source: 'home',
      });
      expect(answer.days.map((d) => d.day)).toEqual([
        '2026-09-27',
        '2026-09-28',
        '2026-09-29',
        '2026-09-30',
        '2026-10-01',
        '2026-10-02',
        '2026-10-03',
      ]);
      expect(answer.days[0].outfit).toMatchObject({
        occasion: 'evening',
        hours: { from: 18, to: 23 },
      });
      expect(answer.days[0].outfit.torsoWarmth).toBeGreaterThanOrEqual(1);
    });

    it('refuses days outside the forecast', async () => {
      for (const args of [
        { from: '2026-09-26', to: '2026-09-27' },
        { from: '2026-10-11', to: '2026-10-13' },
      ]) {
        const answer = await callTool(t, token, 'get_weather', args);
        expect(answer.isError).toBe(true);
        expect(answer.value.error).toBe(
          'Ask for days from 2026-09-27 to 2026-10-12, from before to',
        );
      }
    });

    it("adds each entry's weather to get_calendar within the forecast", async () => {
      const { id } = await createOutfit(t.db, t.owner.id, {
        name: 'Evening out',
        slots: [],
        plan: { day: '2026-09-28', occasion: 'evening' },
      });
      await createOutfit(t.db, t.owner.id, {
        name: 'Far ahead',
        slots: [],
        plan: { day: '2026-10-20', occasion: 'all-day' },
      });
      const calendar = await tool<{
        entries: {
          day: string;
          outfit: { id: number };
          weather?: { day: string; outfit: { occasion: string } };
        }[];
      }>(t, token, 'get_calendar', { from: '2026-09-27', to: '2026-10-25' });
      const evening = calendar.entries.find((e) => e.outfit.id === id)!;
      expect(evening.weather).toMatchObject({
        day: '2026-09-28',
        outfit: { occasion: 'evening' },
      });
      const far = calendar.entries.find((e) => e.day === '2026-10-20')!;
      expect(far.weather).toBeUndefined();
    });
  });

  it('limits how many locations one account can set a minute: each is a fetch and a cached row', async () => {
    const cookie = await t.register('wanderer@example.com');
    const here = (latitude: number) =>
      t.inject({
        method: 'POST',
        url: '/weather/here',
        ...form({ latitude: String(latitude), longitude: '-73.98' }),
        headers: { ...form({}).headers, cookie },
      });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await here(40 + i / 10)).statusCode);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(statuses[10]).toBe(429);
    expect(t.logs.messages('warn', 'RateLimit')).toContainEqual(
      expect.stringMatching(
        /^Rate limit reached: POST \/weather\/here for user \d+$/,
      ),
    );
    // Home counts on its own, and someone else's count is their own.
    const home = await t.inject({
      method: 'POST',
      url: '/weather/home',
      ...form({ name: 'Fort Greene', ...PRECISE }),
      headers: { ...form({}).headers, cookie },
    });
    expect(home.statusCode).toBe(200);
    const neighbour = await t.register('stayer@example.com');
    const theirs = await t.inject({
      method: 'POST',
      url: '/weather/here',
      ...form({ latitude: '40.5', longitude: '-73.98' }),
      headers: { ...form({}).headers, cookie: neighbour },
    });
    expect(theirs.statusCode).toBe(200);
  });

  it('is the signed-in user’s own: another account starts with nothing', async () => {
    const cookie = await t.register('neighbour@example.com');
    const res = await t.inject({
      method: 'GET',
      url: '/weather/summary',
      headers: { ...HX_FRAGMENT, cookie },
    });
    expect(res.body).toContain('Add your city for the weather');
  });

  it('goes with the account', async () => {
    const cookie = await t.register('leaving@example.com');
    await t.inject({
      method: 'POST',
      url: '/weather/home',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ name: 'Brooklyn', ...PRECISE }).toString(),
    });
    const [{ id }] = await t.db
      .select({ id: userWeather.userId })
      .from(userWeather)
      .where(eq(userWeather.homeName, 'Brooklyn'));
    // The row cascades with the user, whichever path deletes it.
    await t.db.delete(user).where(eq(user.id, id));
    expect(
      await t.db.select().from(userWeather).where(eq(userWeather.userId, id)),
    ).toEqual([]);
  });
});

describe('weather off (WEATHER_ENABLED=false)', () => {
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

  it('fetches nothing and stores no location', async () => {
    for (const url of ['/weather/summary', '/weather/places?q=Brooklyn']) {
      const res = await t.inject({ method: 'GET', url, headers: HX_FRAGMENT });
      expect(res.statusCode).toBe(404);
    }
    for (const [url, fields] of [
      ['/weather/home', { name: 'Brooklyn', ...PRECISE }],
      ['/weather/here', PRECISE],
      ['/weather/feedback', { feeling: 'too-warm' }],
    ] as const) {
      const res = await t.inject({ method: 'POST', url, ...form(fields) });
      expect(res.statusCode).toBe(404);
    }
    for (const url of ['/wardrobe', '/calendar', '/auth/profile']) {
      const res = await t.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('/weather/');
      expect(res.body).not.toContain('id="weather');
    }
    const token = await createAccessToken(t);
    expect(await toolNamesOf(t, token)).not.toContain('get_weather');

    expect(stub.hits).toEqual([]);
    expect(await t.db.select().from(userWeather)).toEqual([]);
    expect(await t.db.select().from(weatherForecast)).toEqual([]);
  });
});
