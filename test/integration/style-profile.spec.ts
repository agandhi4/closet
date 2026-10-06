import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { styleProfile } from '../../src/db/schema';
import { saveWeekTemplate } from '../../src/web/week-plan/template';
import { findWeatherSettings, setHome } from '../../src/web/weather/queries';
import { recordStatements } from '../support/query-recorder';
import { startWeatherStub, type WeatherStub } from '../support/weather-stub';
import { createTestApp, type TestApp, unescapeHtml, userIdOf } from './harness';
import { expectFullPage } from './pages';

/**
 * The style profile (#34, slice 34a; src/web/style/CLAUDE.md), through
 * HTTP: the form saves every part and shows it again, its sets only take
 * their own values, the week's rhythm and the home city are shown
 * read-only from where they live, and nobody else reads it. Moved whole
 * from the wardrobe plans' spec when plans went (#337). The matrix row is
 * authorization-account.spec.ts's.
 */
describe('the style profile', () => {
  let t: TestApp;
  let ownerId: number;
  let stranger: string;

  const get = (url: string, headers: Record<string, string> = {}) =>
    t.inject({ method: 'GET', url, headers });
  const post = (url: string, payload: object, cookie?: string) =>
    t.inject({
      method: 'POST',
      url,
      payload,
      headers: cookie ? { cookie } : {},
    });

  beforeAll(async () => {
    t = await createTestApp();
    ownerId = await userIdOf(t, 'owner@example.com');
    stranger = await t.register('stranger-style@example.com');
  });

  afterAll(() => t?.cleanup());

  it('starts empty, saves every part, and shows it again', async () => {
    const blank = await get('/auth/profile/style');
    expect(blank.statusCode).toBe(200);
    expectFullPage(blank);
    expect(blank.body).toContain('Style profile');
    expect(blank.body).not.toMatch(/value="smart-casual"[^>]*checked/);

    const res = await post('/auth/profile/style', {
      styles: ['smart-casual', 'elevated-basics'],
      budget: 'mid',
      palette: ['blue', 'white', 'grey'],
      notes: '  Office three days  ',
      // A page cached before #16 still posts the rhythm: stripped, unread.
      'times-work': '3',
      'per-work': 'week',
    });
    expect(res.statusCode, res.body).toBe(303);
    expect(res.headers.location).toBe('/auth/profile/style?saved=1');
    const [row] = await t.db
      .select()
      .from(styleProfile)
      .where(eq(styleProfile.userId, ownerId));
    // Sets in their list's order, whatever the post's.
    expect(row).toMatchObject({
      styles: ['elevated-basics', 'smart-casual'],
      budget: 'mid',
      palette: ['blue', 'white', 'grey'],
      notes: 'Office three days',
    });
    expect(t.logs.messages('info', 'Web')).toContainEqual(
      `Style profile saved by user ${ownerId}: 2 styles, 3 colours`,
    );

    const page = await get('/auth/profile/style?saved=1');
    expectFullPage(page);
    expect(page.body).toContain('Style profile saved');
    expect(page.body).toMatch(/value="smart-casual"[^>]*checked/);
    expect(page.body).not.toContain('name="times-work"');
  });

  it("shows the week's rhythm read-only, derived from the week template (#16)", async () => {
    const unset = await get('/auth/profile/style');
    expect(unset.body).toContain('Not set yet');
    expect(unset.body).toContain('href="/auth/profile#week"');
    await saveWeekTemplate(t.db, ownerId, [
      { weekday: 1, occasion: 'work' },
      { weekday: 2, occasion: 'work' },
      { weekday: 2, occasion: 'workout' },
      { weekday: 6, occasion: 'daytime' },
    ]);
    const page = unescapeHtml((await get('/auth/profile/style')).body);
    expect(
      [...page.matchAll(/<li data-occasion="([\w-]+)">([^<]+)</g)].map(
        ([, occasion, text]) => [occasion, text],
      ),
    ).toEqual([
      ['workout', 'Workout 1× a week'],
      ['work', 'Work 2× a week'],
      ['daytime', 'Daytime 1× a week'],
    ]);
    await saveWeekTemplate(t.db, ownerId, []);
  });

  it('clears the sets on the next save', async () => {
    const res = await post('/auth/profile/style', { budget: '' });
    expect(res.statusCode).toBe(303);
    const [row] = await t.db
      .select()
      .from(styleProfile)
      .where(eq(styleProfile.userId, ownerId));
    expect(row).toMatchObject({
      styles: null,
      budget: null,
      palette: null,
      notes: null,
    });
  });

  it('refuses a style outside the set', async () => {
    const outside = await post('/auth/profile/style', { styles: ['goth'] });
    expect(outside.statusCode).toBe(400);
    const [row] = await t.db
      .select({ styles: styleProfile.styles })
      .from(styleProfile)
      .where(eq(styleProfile.userId, ownerId));
    expect(row.styles).toBeNull();
  });

  it('is the user’s own: another user sees theirs, empty', async () => {
    const theirs = await get('/auth/profile/style', { cookie: stranger });
    expect(theirs.statusCode).toBe(200);
    expect(theirs.body).not.toMatch(/value="smart-casual"[^>]*checked/);
  });

  it('is linked from the profile', async () => {
    const profile = await get('/auth/profile');
    expect(profile.body).toContain('href="/auth/profile/style"');
  });

  it('says nothing of a home city with the weather off', async () => {
    const page = await get('/auth/profile/style');
    expect(page.body).not.toContain('id="style-home"');
  });

  // A round trip per statement in production (#156): the session, then
  // the profile and the week template in one statement (#251; it was one
  // each), and no weather read with the weather off.
  it('reads the page in 2 statements', async () => {
    const { result, statements } = await recordStatements(() =>
      get('/auth/profile/style'),
    );
    expect(result.statusCode).toBe(200);
    expect(statements).toHaveLength(2); // 3 before #251
    expect(statements[1].sql).toContain('"style_profile"');
    expect(statements[1].sql).toContain('"week_template"');
    expect(statements[1].sql).not.toContain('"user_weather"');
  });
});

/**
 * The style page and the weather's home city (#14): shown read-only from
 * user_weather, with the way to change it (Profile › Weather); the style
 * profile never stores a location of its own.
 */
describe('the style profile beside the weather', () => {
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
    await t?.cleanup();
    await stub?.close();
  });

  it('offers to set a home city when there is none', async () => {
    const page = unescapeHtml(
      (await t.inject({ method: 'GET', url: '/auth/profile/style' })).body,
    );
    expect(page).toMatch(
      /id="style-home"[\s\S]*href="\/auth\/profile#weather"[^>]*>Add your city for the weather/,
    );
  });

  it('shows the home city read-only, linking to Weather to change it, and stores none of it', async () => {
    await setHome(t.db, t.owner.id, {
      name: 'Fort Greene, Brooklyn',
      location: { latitude: 40.69, longitude: -73.97 },
    });
    const page = unescapeHtml(
      (await t.inject({ method: 'GET', url: '/auth/profile/style' })).body,
    );
    expect(page).toContain('Home: Fort Greene, Brooklyn');
    expect(page).toMatch(
      /id="style-home"[\s\S]*href="\/auth\/profile#weather"[^>]*>Change it in Weather/,
    );
    // No field posts it: saving the style profile cannot write a location.
    expect(page).not.toMatch(/name="(home|city|location)/);
    const saved = await t.inject({
      method: 'POST',
      url: '/auth/profile/style',
      payload: { styles: 'minimal', home: 'Elsewhere' },
    });
    expect(saved.statusCode).toBe(303);
    const settings = await findWeatherSettings(t.db, t.owner.id);
    expect(settings.home?.name).toBe('Fort Greene, Brooklyn');
  });

  // The home city rides in the page's one statement with the profile and
  // the week template (#251; they were three).
  it('reads the page in 2 statements, the home city among them', async () => {
    const { result, statements } = await recordStatements(() =>
      t.inject({ method: 'GET', url: '/auth/profile/style' }),
    );
    expect(result.statusCode).toBe(200);
    expect(result.body).toContain('Home: Fort Greene, Brooklyn');
    expect(statements).toHaveLength(2); // 4 before #251
    for (const table of ['style_profile', 'week_template', 'user_weather']) {
      expect(statements[1].sql).toContain(`"${table}"`);
    }
  });
});
