import { and, count, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garmentWear, outfit, outfitCalendar } from '../../src/db/schema';
import { wearIdea } from '../../src/web/today/queries';
import {
  createTestApp,
  recordQueries,
  type TestApp,
  unescapeHtml,
} from './harness';
import { tool, createAccessToken } from './mcp';
import {
  expectFragment,
  expectFullPage,
  expectNativePostForms,
  expectNoScriptNavigation,
  HX_FRAGMENT,
} from './pages';

/**
 * Today (#15), the home screen at GET /: a row per occasion planned today,
 * an all-day row of three ideas while nothing that dresses the day is
 * planned, Refresh through the day's pages, "Wear this" (the pick and the
 * worn mark in one transaction, once however often it is tapped), "Wore
 * it" through the calendar's worn route, and the same model as get_today.
 */

type Fields = Record<string, string | string[]>;

const form = (fields: Fields) => {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of [value].flat()) body.append(name, item);
  }
  return {
    payload: body.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  };
};

/** The rows of a Today page: [kind, occasion], in page order. */
function rowsOf(html: string): [string, string][] {
  return [
    ...html.matchAll(/data-today-row="(\w+)" data-occasion="([\w-]+)"/g),
  ].map((m) => [m[1], m[2]]);
}

/** Every idea card's garment ids, in page order. */
function cardsOf(html: string): number[][] {
  return [...html.matchAll(/data-idea="([\d,]+)"/g)].map((m) =>
    m[1].split(',').map(Number),
  );
}

function refreshUrl(html: string): string | undefined {
  return /hx-get="(\/today\/ideas\?[^"]+)"/.exec(unescapeHtml(html))?.[1];
}

describe('Today', () => {
  let t: TestApp;
  // 4 tops x 3 bottoms x 2 shoes: 24 ideas, plain and casual.
  let tops: number[];
  let bottoms: number[];
  let shoes: number[];

  const garmentIn = async (name: string, category: string, color: string) => {
    const res = await t.inject({
      method: 'POST',
      url: '/wardrobe',
      payload: {
        name,
        category,
        props: '1',
        formality: '2',
        pattern: 'solid',
        color: [color],
      },
    });
    expect(res.statusCode).toBe(302);
    return Number(
      /^\/wardrobe\/(\d+)\?/.exec(String(res.headers.location))![1],
    );
  };

  const get = (url: string, headers: Record<string, string> = {}) =>
    t.inject({ method: 'GET', url, headers });

  /** A saved outfit of these garments; its id. */
  const saveOutfit = async (name: string, garmentIds: number[]) => {
    const res = await t.inject({
      method: 'POST',
      url: '/outfits',
      ...form({
        name,
        category: garmentIds.map(() => 'tops'),
        garmentId: garmentIds.map(String),
      }),
    });
    expect(res.statusCode).toBe(302);
    return Number(/^\/outfits\/(\d+)$/.exec(String(res.headers.location))![1]);
  };

  /** Plans an outfit today for `occasion`; the entry's id. */
  const planToday = async (outfitId: number, occasion: string) => {
    const res = await t.inject({
      method: 'POST',
      url: '/calendar',
      payload: { date: t.today(), outfitId: String(outfitId), occasion },
    });
    expect(res.statusCode).toBe(302);
    const [entry] = await t.db
      .select({ id: outfitCalendar.id })
      .from(outfitCalendar)
      .where(
        and(
          eq(outfitCalendar.outfitId, outfitId),
          eq(outfitCalendar.day, t.today()),
        ),
      );
    return entry.id;
  };

  const clearToday = () =>
    t.db.delete(outfitCalendar).where(eq(outfitCalendar.day, t.today()));

  beforeAll(async () => {
    t = await createTestApp();
    tops = await Promise.all(
      ['white', 'grey', 'black', 'beige'].map((color, i) =>
        garmentIn(`Tee ${i}`, 'tops', color),
      ),
    );
    bottoms = await Promise.all(
      ['blue', 'black', 'beige'].map((color, i) =>
        garmentIn(`Trousers ${i}`, 'bottoms', color),
      ),
    );
    shoes = await Promise.all(
      ['white', 'brown'].map((color, i) =>
        garmentIn(`Shoes ${i}`, 'footwear', color),
      ),
    );
  });

  afterAll(() => t?.cleanup());

  describe('the page', () => {
    it('sends a signed-out visitor to log in', async () => {
      const res = await t.inject({ method: 'GET', url: '/', anonymous: true });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/auth/login');
    });

    it('with nothing planned: an all-day row of three ideas to wear, Today lit in the dock', async () => {
      const res = await get('/');
      expect(res.statusCode).toBe(200);
      expectFullPage(res);
      expectNativePostForms(res);
      expectNoScriptNavigation(res);
      const html = unescapeHtml(res.body);
      expect(rowsOf(html)).toEqual([['ideas', 'all-day']]);
      const cards = cardsOf(html);
      expect(cards).toHaveLength(3);
      for (const card of cards) {
        expect(card).toHaveLength(3);
      }
      // Each card's "Wear this" posts its garments and the occasion.
      expect(html.match(/action="\/today\/wear"/g)).toHaveLength(3);
      expect(html).toContain('name="occasion" value="all-day"');
      // The dock: Today first and lit.
      expect(html).toMatch(
        /<div class="dock"><a class="dock-active" aria-current="page" href="\/">/,
      );
      // Offline: the writes are guarded and the page says why.
      expect(html).toContain('data-offline-note');
      expect(html.match(/data-needs-network/g)!.length).toBeGreaterThanOrEqual(
        3,
      );
      expect(html).toContain(
        `/outfits/ideas?for=day:${t.today()}&occasion=all-day`,
      );
      expect(html).toContain(`/calendar/plan?for=day:${t.today()}`);
    });

    it('shows the same three on a reload (the day’s seed)', async () => {
      const first = cardsOf((await get('/')).body);
      const again = cardsOf((await get('/')).body);
      expect(again).toEqual(first);
    });

    it('a run and a dinner planned: their rows, and still the all-day ideas first', async () => {
      const run = await saveOutfit('Run', [tops[0], bottoms[0], shoes[0]]);
      const dinner = await saveOutfit('Dinner', [
        tops[2],
        bottoms[1],
        shoes[1],
      ]);
      const runEntry = await planToday(run, 'workout');
      const dinnerEntry = await planToday(dinner, 'evening');
      const html = unescapeHtml((await get('/')).body);
      expect(rowsOf(html)).toEqual([
        ['ideas', 'all-day'],
        ['planned', 'workout'],
        ['planned', 'evening'],
      ]);
      expect(html).toContain(`data-entry="${runEntry}"`);
      // A planned outfit: "Wore it" through the calendar's worn route,
      // back to Today, and "Change" into the gallery for its occasion.
      expect(html).toContain(`action="/calendar/${dinnerEntry}/worn"`);
      expect(html).toContain('name="returnTo" value="/"');
      expect(html).toContain(
        `/outfits/ideas?for=day:${t.today()}&occasion=evening`,
      );
      await clearToday();
    });

    it('an outfit planned for work dresses the day: no ideas row', async () => {
      const office = await saveOutfit('Office', [tops[1], bottoms[2]]);
      await planToday(office, 'work');
      expect(rowsOf((await get('/')).body)).toEqual([['planned', 'work']]);
      await clearToday();
    });

    // #158: production pays a ~114 ms round trip per statement. The session,
    // then today's entries, then (undressed) the pool and the generator's
    // memory (saved outfits and clashes) in one statement (ideasFor's
    // selectScalars, #168). With the weather on, its read joins the
    // entries' round (weather.spec.ts).
    // Nothing reads "worn today": the page never shows it.
    it('reads in three statements, two when the day is dressed', async () => {
      await clearToday();
      const undressed = await recordQueries(() => get('/'));
      expect(undressed.statements).toBe(3);
      // Worn today (somethingWornSql, get_today's `worn`) is not read for
      // the page.
      expect(undressed.sql.join('\n')).not.toMatch(/\)\s+or exists \(/);

      const office = await saveOutfit('Office again', [tops[2], bottoms[0]]);
      await planToday(office, 'work');
      const dressed = await recordQueries(() => get('/'));
      expect(dressed.statements).toBe(2);
      await clearToday();
    });

    it('an empty closet says what ideas need', async () => {
      const cookie = await t.register('empty-today@example.com');
      const res = await get('/', { cookie });
      expect(res.statusCode).toBe(200);
      const html = unescapeHtml(res.body);
      expect(rowsOf(html)).toEqual([['ideas', 'all-day']]);
      expect(cardsOf(html)).toEqual([]);
      expect(html).toContain('No ideas yet');
      expect(refreshUrl(html)).toBeUndefined();
    });
  });

  describe('Refresh', () => {
    it('walks the day’s pages three at a time, then starts over', async () => {
      const page = (await get('/')).body;
      const seen = cardsOf(page);
      let url = refreshUrl(page);
      expect(url).toMatch(/page=2$/);
      for (
        let pages = 0;
        url && !/page=1$/.test(url) && pages < 12;
        pages += 1
      ) {
        const res = await get(url, HX_FRAGMENT);
        expect(res.statusCode).toBe(200);
        expectFragment(res);
        seen.push(...cardsOf(res.body));
        url = refreshUrl(res.body);
      }
      // No idea twice across the pages.
      const keys = seen.map((ids) => [...ids].sort().join(','));
      expect(new Set(keys).size).toBe(keys.length);
      expect(seen.length).toBeGreaterThan(3);
      expect(url).toMatch(/page=1$/);
    });

    it('reads in two statements: the session, then the pool and the generator’s memory together', async () => {
      const url = refreshUrl((await get('/')).body)!;
      const record = await recordQueries(() => get(url, HX_FRAGMENT));
      expect(record.statements).toBe(2);
    });

    it('reads a malformed occasion or page as all day, page 1', async () => {
      const first = cardsOf((await get('/')).body);
      const res = await get(
        '/today/ideas?occasion=brunch&page=zz',
        HX_FRAGMENT,
      );
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('data-occasion="all-day"');
      expect(cardsOf(res.body)).toEqual(first);
    });
  });

  describe('"Wear this"', () => {
    const outfitsOf = async (ids: number[]) =>
      (
        await t.db
          .select({ id: outfit.id })
          .from(outfit)
          .where(
            sql`(select array_agg(garment_id order by garment_id) from outfit_slot where outfit_id = ${outfit.id} and garment_id is not null) = ${sql.raw(`array[${[...ids].sort((a, b) => a - b).join(',')}]::int[]`)}`,
          )
      ).map((row) => row.id);

    const wear = (garmentIds: number[], occasion = 'all-day') =>
      t.inject({
        method: 'POST',
        url: '/today/wear',
        ...form({ garmentId: garmentIds.map(String), occasion }),
      });

    it('plans the idea today and marks it worn, then Today shows it worn', async () => {
      const [idea] = cardsOf((await get('/')).body);
      const res = await wear(idea);
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/');
      const [outfitId] = await outfitsOf(idea);
      const [entry] = await t.db
        .select()
        .from(outfitCalendar)
        .where(eq(outfitCalendar.outfitId, outfitId));
      expect(entry).toMatchObject({ day: t.today(), occasion: 'all-day' });
      expect(entry.wornAt).not.toBeNull();
      expect(
        await t.db.$count(
          garmentWear,
          eq(garmentWear.outfitCalendarId, entry.id),
        ),
      ).toBe(idea.length);
      expect(t.logs.messages('info', 'Web')).toContainEqual(
        expect.stringMatching(
          new RegExp(
            `^Idea worn by user ${t.owner.id} on ${t.today()} \\(all-day\\): outfit ${outfitId} .*marked worn`,
          ),
        ),
      );

      const html = unescapeHtml((await get('/')).body);
      // Worn: the day is dressed, so no ideas; the undo posts worn=0.
      expect(rowsOf(html)).toEqual([['planned', 'all-day']]);
      expect(html).toContain('Worn today');
      expect(html).toContain('name="worn" value="0"');
    });

    it('a second tap changes nothing: one outfit, one entry, the wears once', async () => {
      await clearToday();
      const [idea] = cardsOf((await get('/')).body);
      const before = await t.db.$count(garmentWear);
      for (let n = 0; n < 2; n += 1) {
        expect((await wear(idea)).statusCode).toBe(303);
      }
      const outfits = await outfitsOf(idea);
      expect(outfits).toHaveLength(1);
      expect(
        await t.db.$count(
          outfitCalendar,
          eq(outfitCalendar.outfitId, outfits[0]),
        ),
      ).toBe(1);
      expect(await t.db.$count(garmentWear)).toBe(before + idea.length);
      expect(t.logs.messages('info', 'Web').at(-1)).toMatch(/already worn$/);
    });

    // #158: the owner lock is taken once, by wearIdea; pickIdea, insertEntry
    // and setEntryWorn join its transaction (ownerTransaction) instead of
    // each opening a savepoint and locking again (25 statements before).
    it('a tap is one transaction that locks once: seven statements for a repeat', async () => {
      await clearToday();
      const [idea] = cardsOf((await get('/')).body);
      expect((await wear(idea)).statusCode).toBe(303);
      const again = await recordQueries(() => wear(idea));
      // Session; begin, the lock (with its timeout), the garments with the
      // outfit they already are (one statement, #168), its planner
      // take-over, the entry kept, locked and read already worn (one
      // statement, planToWear, #166); commit.
      expect(again.statements).toBe(7);
      const sql = again.sql.join('\n');
      expect(sql).not.toMatch(/savepoint/i);
      expect(sql.match(/for no key update/g)).toHaveLength(1);
    });

    it('two taps at the same moment make one outfit, one entry, one set of wears', async () => {
      await clearToday();
      const racing = [tops[3], bottoms[2], shoes[1]];
      const ownerId = t.owner.id;
      const input = {
        garmentIds: racing,
        occasion: 'all-day' as const,
        today: t.today(),
        at: new Date(),
      };
      let picked!: () => void;
      const aPicked = new Promise<void>((resolve) => (picked = resolve));
      let release!: () => void;
      const aReleased = new Promise<void>((resolve) => (release = resolve));
      const a = t.db.transaction(async (tx) => {
        const result = await wearIdea(tx, ownerId, input);
        picked();
        await aReleased;
        return result;
      });
      await aPicked;
      const b = wearIdea(t.db, ownerId, input);
      await expect
        .poll(async () => {
          const { rows } = await t.db.execute<{ waiting: number }>(
            sql`select count(*)::int as waiting from pg_stat_activity
                where datname = current_database() and wait_event_type = 'Lock'`,
          );
          return rows[0].waiting;
        })
        .toBe(1);
      release();
      const [first, second] = await Promise.all([a, b]);
      expect(first).toMatchObject({ worn: { changed: true } });
      expect(second).toMatchObject({
        entryId: (first as { entryId: number }).entryId,
        worn: { changed: false },
      });
      const outfits = await outfitsOf(racing);
      expect(outfits).toHaveLength(1);
      expect(
        (
          await t.db
            .select({ n: count() })
            .from(garmentWear)
            .where(
              eq(
                garmentWear.outfitCalendarId,
                (first as { entryId: number }).entryId,
              ),
            )
        )[0].n,
      ).toBe(racing.length);
    });

    it('refuses garments outside the closet, writing nothing (404), and a malformed post (400)', async () => {
      const cookie = await t.register('other-today@example.com');
      const theirs = await t.inject({
        method: 'POST',
        url: '/wardrobe',
        payload: { name: 'Theirs', category: 'tops' },
        headers: { cookie },
      });
      const other = Number(
        /^\/wardrobe\/(\d+)\?/.exec(String(theirs.headers.location))![1],
      );
      const outfitsBefore = await t.db.$count(outfit);
      const res = await wear([other, bottoms[0]]);
      expect(res.statusCode).toBe(404);
      expect(await t.db.$count(outfit)).toBe(outfitsBefore);

      expect((await wear([tops[0]], 'brunch')).statusCode).toBe(400);
      expect(
        (
          await t.inject({
            method: 'POST',
            url: '/today/wear',
            ...form({ occasion: 'all-day' }),
          })
        ).statusCode,
      ).toBe(400);
    });
  });

  describe('"Wore it" on a planned outfit', () => {
    it('marks the entry worn and comes back to Today; an unsafe returnTo goes to the week', async () => {
      await clearToday();
      const planned = await saveOutfit('Planned', [tops[1], bottoms[1]]);
      const entry = await planToday(planned, 'evening');
      const res = await t.inject({
        method: 'POST',
        url: `/calendar/${entry}/worn`,
        payload: { worn: '1', returnTo: '/' },
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/');
      const html = unescapeHtml((await get('/')).body);
      expect(html).toMatch(
        new RegExp(`data-entry="${entry}"[\\s\\S]*Worn today`),
      );

      const undo = await t.inject({
        method: 'POST',
        url: `/calendar/${entry}/worn`,
        payload: { worn: '0', returnTo: '//evil.example/' },
      });
      expect(undo.statusCode).toBe(303);
      expect(undo.headers.location).toBe('/calendar');
    });
  });

  describe('get_today (MCP)', () => {
    it('answers the page’s model as data', async () => {
      await clearToday();
      const dinner = await saveOutfit('Dinner again', [tops[0], bottoms[1]]);
      const entry = await planToday(dinner, 'evening');
      const token = await createAccessToken(t);
      const today = await tool<{
        day: string;
        wornToday: boolean;
        weather: unknown;
        rows: {
          occasion: string;
          planned?: { entryId: number; worn: boolean }[];
          suggestions?: { garmentIds: number[] }[];
        }[];
      }>(t, token, 'get_today');
      expect(today.day).toBe(t.today());
      expect(today.weather).toBeNull();
      expect(today.rows.map((row) => row.occasion)).toEqual([
        'all-day',
        'evening',
      ]);
      expect(today.rows[0].suggestions!.map((s) => s.garmentIds)).toEqual(
        cardsOf((await get('/')).body),
      );
      expect(today.rows[1].planned).toEqual([
        expect.objectContaining({ entryId: entry, worn: false }),
      ]);
    });
  });
});
