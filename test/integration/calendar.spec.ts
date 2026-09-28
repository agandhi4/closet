import { count, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { outfit as outfitTable, outfitCalendar } from '../../src/db/schema';
import {
  addDays,
  dayOfWeek,
  startOfWeek,
} from '../../src/web/calendar/calendar-date';
import { createGarment, jpegPhoto, uploadPhoto } from './garments';
import {
  createTestApp,
  extractImgSrcs,
  hasText,
  hxLocationPath,
  recordQueries,
  TestApp,
  unescapeHtml,
} from './harness';
import { dayColumns, planButtonLabel } from './calendar-page';
import { expectFullPage } from './pages';

/**
 * The calendar pages and their writes: the week agenda renders seven day
 * blocks with each entry under its own day and steps by week, the month
 * shows each day's collage and links to its week, and adding, deleting and
 * marking entries worn change exactly the rows they should.
 *
 * Weeks are in 2030 so the real "today" highlight can never land in them;
 * "today" and the default week are pinned down with a fake clock below and
 * in src/web/calendar/calendar-view.spec.ts. Rows are read through Drizzle.
 */

const WEEK = ['06', '07', '08', '09', '10', '11', '12'].map(
  (day) => `2030-10-${day}`,
);
const WEEK_URL = '/calendar?week=2030-10-09';

const form = (fields: Record<string, string>) => ({
  payload: new URLSearchParams(fields).toString(),
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
});

/** The day of the month in a day block's heading ("Oct 6"). */
function dayNumber(column: string): number {
  return Number(
    /<h2[^>]*>[^<]*<span[^>]*>\s*\w{3} (\d+)\s*</.exec(column)?.[1],
  );
}

describe('calendar', () => {
  let t: TestApp;

  const createOutfit = async (name: string, garmentIds: number[] = []) => {
    const body = new URLSearchParams({ name });
    for (const id of garmentIds) {
      body.append('category', 'tops');
      body.append('garmentId', String(id));
    }
    const res = await t.inject({
      method: 'POST',
      url: '/outfits',
      payload: body.toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(302);
    return Number(/^\/outfits\/(\d+)$/.exec(String(res.headers.location))![1]);
  };

  /** POST /calendar as the outfit page's Plan sheet sends it (a native post). */
  const schedule = async (outfitId: number, date: string) => {
    const res = await t.inject({
      method: 'POST',
      url: '/calendar',
      ...form({ outfitId: String(outfitId), date }),
    });
    expect(res.statusCode).toBe(302);
    const [entry] = await t.db
      .select({ id: outfitCalendar.id })
      .from(outfitCalendar)
      .where(eq(outfitCalendar.outfitId, outfitId))
      .orderBy(desc(outfitCalendar.id))
      .limit(1);
    return entry.id;
  };

  const entriesOf = (outfitId: number) =>
    t.db
      .select()
      .from(outfitCalendar)
      .where(eq(outfitCalendar.outfitId, outfitId))
      .orderBy(outfitCalendar.id);

  const entryById = async (id: number) =>
    (
      await t.db.select().from(outfitCalendar).where(eq(outfitCalendar.id, id))
    ).at(0);

  const entryCount = async () =>
    (await t.db.select({ n: count() }).from(outfitCalendar))[0].n;

  // JSX escapes '&' in attribute values; match URLs as the browser reads them.
  const weekPage = async (url = WEEK_URL) => {
    const res = await t.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    return unescapeHtml(res.body);
  };

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  describe('GET /calendar', () => {
    it('renders the Sunday-to-Saturday week containing ?week= as seven day columns', async () => {
      const html = await weekPage();
      const columns = dayColumns(html);
      expect([...columns.keys()]).toEqual(WEEK);
      expect([...columns.values()].map(dayNumber)).toEqual([
        6, 7, 8, 9, 10, 11, 12,
      ]);
      expect(hasText(columns.get(WEEK[0])!, 'Sunday')).toBe(true);
      expect(hasText(columns.get(WEEK[6])!, 'Saturday')).toBe(true);
      // No day in 2030 is today.
      expect(html).not.toContain('aria-current="date"');
      expect(html).not.toMatch(/<h2[^>]*text-primary/);
    });

    // #165: production pays a ~114 ms round trip per statement. The session,
    // then the week's entries, its looks and the week template together in
    // one statement (weekContext; three in parallel before).
    it('reads the week in two statements', async () => {
      const read = await recordQueries(() =>
        t.inject({ method: 'GET', url: WEEK_URL }),
      );
      expect(read.statements).toBe(2);
    });

    it('steps a week at a time and strips the days down to their blocks', async () => {
      const html = await weekPage();
      // With its year: nothing else on the page says which (#99).
      expect(html).toMatch(/>\s*Oct 6 – Oct 12, 2030\s*</);
      expect(html).toContain('href="/calendar?week=2030-09-29"');
      expect(html).toContain('href="/calendar?week=2030-10-13"');
      expect(
        [...html.matchAll(/href="#day-(\d{4}-\d{2}-\d{2})"/g)].map((m) => m[1]),
      ).toEqual(WEEK);
      // The tabs: Week (this page), Month and Trips.
      expect(html).toMatch(
        /<a role="tab" href="\/calendar" class="tab tab-active"/,
      );
      expect(html).toContain('href="/calendar/month"');
      expect(html).toContain('href="/trips"');
    });

    it('a week across the new year is labelled across it', async () => {
      const html = await weekPage('/calendar?week=2030-12-31');
      expect(html).toMatch(/>\s*Dec 29, 2030 – Jan 4, 2031\s*</);
      expect([...dayColumns(html).keys()].at(-1)).toBe('2031-01-04');
    });

    it("without ?week= renders the app's current week, Sunday to Saturday", async () => {
      const dates = [...dayColumns(await weekPage('/calendar')).keys()];
      const sunday = startOfWeek(t.today());
      expect(dayOfWeek(sunday)).toBe(0);
      expect(dates).toEqual(
        [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(sunday, i)),
      );
    });

    it('an unparseable ?week= falls back to a full week instead of failing', async () => {
      expect(dayColumns(await weekPage('/calendar?week=not-a-date')).size).toBe(
        7,
      );
    });

    it("a malformed ?week= falls back to the current week, and the old mini month's ?calMonth= is ignored", async () => {
      const current = [...dayColumns(await weekPage('/calendar')).keys()];
      for (const query of [
        'week=2030-02-30',
        'week=2030-10-09T00:00:00Z',
        'calMonth=2030-13',
        'week=garbage&calMonth=2030-01',
      ]) {
        const html = await weekPage(`/calendar?${query}`);
        expect({ query, days: [...dayColumns(html).keys()] }).toEqual({
          query,
          days: current,
        });
      }
    });

    describe('today in APP_TIMEZONE (default America/New_York)', () => {
      // Only Date is faked: timers, the database driver and the session
      // (whose JWT has no not-before) keep working.
      const at = async (instant: string) => {
        vi.useFakeTimers({ toFake: ['Date'], now: new Date(instant) });
        try {
          return await weekPage('/calendar');
        } finally {
          vi.useRealTimers();
        }
      };

      it("at 21:30 on a Friday in New York, today is New York's Friday, not UTC's Saturday", async () => {
        const html = await at('2026-09-25T21:30:00-04:00');
        const columns = dayColumns(html);
        expect([...columns.keys()][0]).toBe('2026-09-20');
        expect(columns.get('2026-09-25')).toMatch(/<h2[^>]*text-primary/);
        expect(hasText(columns.get('2026-09-25')!, 'Today')).toBe(true);
        expect(columns.get('2026-09-26')).not.toMatch(/<h2[^>]*text-primary/);
        expect(html).toMatch(/href="#day-2026-09-25"[^>]*aria-current="date"/);
        expect(html.match(/aria-current="date"/g)).toHaveLength(1);
      });

      it('on Saturday evening the default week is still this week', async () => {
        const html = await at('2026-09-26T21:00:00-04:00');
        expect([...dayColumns(html).keys()][0]).toBe('2026-09-20');
      });
    });

    it('renders each entry under its own day and nowhere else', async () => {
      const brunch = await createOutfit('Brunch look');
      const untitled = await createOutfit('');
      const brunchEntry = await schedule(brunch, '2030-10-08');
      const untitledEntry = await schedule(untitled, '2030-10-12');
      await schedule(brunch, '2030-10-13'); // next week: not on this page

      const columns = dayColumns(await weekPage());
      const tuesday = columns.get('2030-10-08')!;
      const saturday = columns.get('2030-10-12')!;

      expect(hasText(tuesday, 'Brunch look')).toBe(true);
      expect(tuesday).toContain(`action="/calendar/${brunchEntry}/delete"`);
      // The chip edits the outfit in Styling (#42), back to this day of
      // the week, not the top of it (selfies.spec.ts: a selfie's too).
      expect(unescapeHtml(tuesday)).toContain(
        `/styling?outfit=${brunch}&returnTo=%2Fcalendar%3Fweek%3D2030-10-08%23day-2030-10-08"`,
      );
      expect(hasText(saturday, 'Untitled Outfit')).toBe(true);
      expect(saturday).toContain(`action="/calendar/${untitledEntry}/delete"`);
      // 2030 is ahead: a planned day has no worn pill.
      expect(saturday).not.toContain(`/calendar/${untitledEntry}/worn`);

      for (const [date, column] of columns) {
        if (date !== '2030-10-08') {
          expect(hasText(column, 'Brunch look')).toBe(false);
        }
        if (date !== '2030-10-12') {
          expect(hasText(column, 'Untitled Outfit')).toBe(false);
        }
      }

      const nextWeek = dayColumns(await weekPage('/calendar?week=2030-10-13'));
      expect(hasText(nextWeek.get('2030-10-13')!, 'Brunch look')).toBe(true);
    });

    it("shows the outfit's collage beside its name", async () => {
      const garment = await createGarment(t, {
        name: 'Photo top',
        category: 'tops',
      });
      await uploadPhoto(t, garment, await jpegPhoto(64, 64));
      const outfit = await createOutfit('Pictured', [garment]);
      await schedule(outfit, '2030-10-10');

      const thursday = dayColumns(await weekPage()).get('2030-10-10')!;
      const thumbs = extractImgSrcs(thursday);
      expect(thumbs).toHaveLength(1);
      expect(thumbs[0]).toMatch(
        /^\/file\/thumb\/[0-9a-f-]{36}\.webp\?v=1&s=[\w-]{16}$/,
      );
      expect(hasText(thursday, '>Pictured<')).toBe(true);
      // One link edits the outfit, named for it alone (not its garments).
      expect(hasText(thursday, 'aria-label="Pictured"')).toBe(true);
      expect(thursday.match(/href="\/styling\?outfit=/g)).toHaveLength(1);
    });

    it("each day's + Plan opens its sheet: the occasion, then Ideas, a saved outfit or Styling, all for that day", async () => {
      const html = await weekPage();
      const sheets = [
        ...html.matchAll(
          /<dialog[^>]*data-plan-sheet="([\d-]+)"[\s\S]*?<\/dialog>/g,
        ),
      ];
      expect(sheets.map((m) => m[1])).toEqual(WEEK);
      const wednesday = sheets[3][0];
      expect(wednesday).toContain('Plan Wednesday, Oct 9');
      expect(wednesday).toMatch(/<form method="get" action="\/outfits\/ideas"/);
      expect(wednesday).toContain(
        '<input type="hidden" name="for" value="day:2030-10-09"/>',
      );
      // One radio per occasion, all day chosen until an opener picks another.
      const radios = [
        ...wednesday.matchAll(
          /type="radio" name="occasion" value="([a-z-]+)"/g,
        ),
      ].map((m) => m[1]);
      expect(radios).toEqual([
        'all-day',
        'workout',
        'work',
        'daytime',
        'evening',
        'night-out',
      ]);
      expect(wednesday).toMatch(
        /value="all-day" id="plan-2030-10-09-all-day"[^>]*checked/,
      );
      expect(
        [...wednesday.matchAll(/formaction="([^"]+)"/g)].map((m) => m[1]),
      ).toEqual(['/outfits/ideas', '/outfits', '/styling']);
      // The day's button names the radio it checks before opening the sheet.
      expect(dayColumns(html).get('2030-10-09')).toMatch(
        /data-plan="plan-2030-10-09-all-day" data-day-plan="2030-10-09"/,
      );
    });

    it("lists the week template's occasions a day has no outfit for, from today on (#16)", async () => {
      vi.useFakeTimers({
        toFake: ['Date'],
        now: new Date('2026-09-23T12:00:00-04:00'),
      });
      try {
        // Monday to Friday work, an evening on Friday; nothing at weekends.
        const body = new URLSearchParams();
        for (const weekday of [0, 1, 2, 3, 4, 5, 6]) {
          const work = weekday >= 1 && weekday <= 5;
          body.append(`day-${weekday}`, work ? 'work' : '');
          if (weekday === 5) body.append(`around-${weekday}`, 'evening');
        }
        const saved = await t.inject({
          method: 'POST',
          url: '/auth/profile/week',
          payload: body.toString(),
          headers: form({}).headers,
        });
        expect(saved.statusCode).toBe(303);
        const friday = await createOutfit('Friday office');
        await t.inject({
          method: 'POST',
          url: '/calendar',
          ...form({
            outfitId: String(friday),
            date: '2026-09-25',
            occasion: 'work',
          }),
        });

        const columns = dayColumns(await weekPage('/calendar'));
        const open = (day: string) =>
          [...columns.get(day)!.matchAll(/data-open-slot="([a-z-]+)"/g)].map(
            (m) => m[1],
          );
        // Monday and Tuesday are past; Wednesday is today.
        expect(open('2026-09-21')).toEqual([]);
        expect(open('2026-09-23')).toEqual(['work']);
        expect(open('2026-09-25')).toEqual(['evening']);
        expect(open('2026-09-26')).toEqual([]);
        expect(columns.get('2026-09-25')).toContain(
          'data-plan="plan-2026-09-25-evening"',
        );
        // A day with open slots has them as its one way into the sheet,
        // with or without an outfit already; without any, its "+ Plan".
        const html = await weekPage('/calendar');
        expect(planButtonLabel(html, '2026-09-23')).toBeUndefined();
        expect(planButtonLabel(html, '2026-09-25')).toBeUndefined();
        expect(planButtonLabel(html, '2026-09-26')).toBe('+ Plan');
      } finally {
        vi.useRealTimers();
        const cleared = new URLSearchParams();
        for (const weekday of [0, 1, 2, 3, 4, 5, 6]) {
          cleared.append(`day-${weekday}`, '');
        }
        await t.inject({
          method: 'POST',
          url: '/auth/profile/week',
          payload: cleared.toString(),
          headers: form({}).headers,
        });
      }
    });
  });

  describe('GET /calendar/month', () => {
    const monthPage = (query = '') => weekPage(`/calendar/month${query}`);

    it('lays the month out Sunday to Saturday, each day linking to its block in its week', async () => {
      const html = await monthPage('?month=2030-10');
      expect(html).toMatch(/<h2[^>]*>\s*October 2030\s*</);
      expect(html).toMatch(
        /<a role="tab" href="\/calendar\/month" class="tab tab-active"/,
      );
      const days = [...html.matchAll(/data-month-day="([\d-]+)"/g)].map(
        (m) => m[1],
      );
      expect(days).toHaveLength(31);
      expect(days[0]).toBe('2030-10-01');
      expect(html).toContain('href="/calendar?week=2030-10-09#day-2030-10-09"');
      // October 2030 starts on a Tuesday: two blank cells before it.
      expect(html).toMatch(/<tr>(<td class="p-0 align-top"><\/td>){2}<td/);
      expect(html).toContain('href="/calendar/month?month=2030-09"');
      expect(html).toContain('href="/calendar/month?month=2030-11"');
    });

    it("shows a day's first outfit as a collage, how many more, and whether it was worn", async () => {
      const garment = await createGarment(t, {
        name: 'Month top',
        category: 'tops',
      });
      await uploadPhoto(t, garment, await jpegPhoto(64, 64));
      const pictured = await createOutfit('Month pictured', [garment]);
      const another = await createOutfit('Month another');
      await t.inject({
        method: 'POST',
        url: '/calendar',
        ...form({
          outfitId: String(another),
          date: '2029-03-14',
          occasion: 'evening',
        }),
      });
      const first = await schedule(pictured, '2029-03-14');
      await t.db
        .update(outfitCalendar)
        .set({ wornAt: new Date() })
        .where(eq(outfitCalendar.id, first));

      const html = await monthPage('?month=2029-03');
      const cell = /<a[^>]*data-month-day="2029-03-14"[\s\S]*?<\/a>/.exec(
        html,
      )![0];
      // All day comes before the evening: its collage is the one shown.
      expect(extractImgSrcs(cell)).toHaveLength(1);
      expect(cell).toContain('+1');
      expect(cell).toMatch(/<a[^>]*data-worn=""/);
      expect(cell).toContain(
        'aria-label="Wednesday, Mar 14, Month pictured, Month another, Worn"',
      );
      const empty = /<a[^>]*data-month-day="2029-03-15"[\s\S]*?<\/a>/.exec(
        html,
      )![0];
      expect(extractImgSrcs(empty)).toEqual([]);
      expect(empty).not.toContain('data-worn');
    });

    it('without ?month=, or a malformed one, shows this month with today marked', async () => {
      vi.useFakeTimers({
        toFake: ['Date'],
        now: new Date('2026-09-25T21:30:00-04:00'),
      });
      try {
        for (const query of ['', '?month=2026-13', '?month=garbage']) {
          const html = await monthPage(query);
          expect(html, query).toMatch(/>\s*September 2026\s*</);
          expect(html).toMatch(
            /aria-current="date" data-month-day="2026-09-25"/,
          );
        }
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('POST /calendar', () => {
    it('creates an entry on that day and redirects to its week', async () => {
      const outfit = await createOutfit('Redirected');
      const res = await t.inject({
        method: 'POST',
        url: '/calendar',
        ...form({ outfitId: String(outfit), date: '2030-10-09' }),
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/calendar?week=2030-10-09');

      const [entry] = await entriesOf(outfit);
      expect(entry.day).toBe('2030-10-09');
      expect(entry.wornAt).toBeNull();
      expect(entry.ownerId).toBe(t.owner.id);
    });

    it('redirects to the posted week when there is one', async () => {
      const outfit = await createOutfit('Week field');
      const res = await t.inject({
        method: 'POST',
        url: '/calendar',
        ...form({
          outfitId: String(outfit),
          date: '2030-10-10',
          week: '2030-10-06',
        }),
      });
      expect(res.headers.location).toBe('/calendar?week=2030-10-06');
    });

    it('404s an unknown outfit and writes nothing', async () => {
      const before = await entryCount();
      const res = await t.inject({
        method: 'POST',
        url: '/calendar',
        ...form({ outfitId: '999999', date: '2030-10-09' }),
      });
      expect(res.statusCode).toBe(404);
      expect(await entryCount()).toBe(before);
    });

    it('rejects a malformed date with a 400 and writes nothing', async () => {
      const outfit = await createOutfit('Bad date');
      const res = await t.inject({
        method: 'POST',
        url: '/calendar',
        ...form({ outfitId: String(outfit), date: 'garbage' }),
      });
      expect(res.statusCode).toBe(400);
      expect(await entriesOf(outfit)).toHaveLength(0);
    });

    it('answers every malformed field with the 400 error page and writes nothing', async () => {
      const outfit = await createOutfit('Malformed fields');
      const before = await entryCount();
      const malformed: Record<string, string>[] = [
        { outfitId: String(outfit), date: '2030-02-30' },
        { outfitId: String(outfit), date: '2030-10-09T00:00:00Z' },
        { outfitId: String(outfit) },
        { outfitId: 'abc', date: '2030-10-09' },
        { outfitId: '99999999999', date: '2030-10-09' },
        { outfitId: String(outfit), date: '2030-10-09', week: 'garbage' },
      ];
      for (const fields of malformed) {
        const res = await t.inject({
          method: 'POST',
          url: '/calendar',
          ...form(fields),
        });
        expect({ fields, status: res.statusCode }).toEqual({
          fields,
          status: 400,
        });
        expectFullPage(res);
      }
      expect(await entryCount()).toBe(before);
    });

    it('is idempotent: scheduling the same outfit on the same day twice answers the same and keeps one entry', async () => {
      const outfit = await createOutfit('Scheduled twice');
      for (let i = 0; i < 2; i++) {
        const res = await t.inject({
          method: 'POST',
          url: '/calendar',
          ...form({ outfitId: String(outfit), date: '2030-10-10' }),
        });
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe('/calendar?week=2030-10-10');
      }
      expect((await entriesOf(outfit)).map((entry) => entry.day)).toEqual([
        '2030-10-10',
      ]);
      // Another day is another entry.
      await schedule(outfit, '2030-10-11');
      expect(await entriesOf(outfit)).toHaveLength(2);
    });

    it('stores the calendar day as a date column', async () => {
      const { rows } = await t.db.execute<{ data_type: string }>(
        sql`select data_type from information_schema.columns
             where table_name = 'outfit_calendar' and column_name = 'day'`,
      );
      expect(rows[0].data_type).toBe('date');
    });
  });

  describe('POST /calendar/:id/delete', () => {
    it('removes only that entry and sends the page back to the week', async () => {
      const outfit = await createOutfit('Deleted entry');
      const keep = await schedule(outfit, '2030-10-07');
      const drop = await schedule(outfit, '2030-10-11');

      const res = await t.inject({
        method: 'POST',
        url: `/calendar/${drop}/delete`,
        ...form({ week: '2030-10-11' }),
        headers: { ...form({}).headers, 'hx-request': 'true' },
      });
      expect(res.statusCode).toBe(200);
      expect(hxLocationPath(res)).toBe('/calendar?week=2030-10-11');

      expect(await entryById(drop)).toBeUndefined();
      expect(await entryById(keep)).toBeDefined();
      expect(
        await t.db.select().from(outfitTable).where(eq(outfitTable.id, outfit)),
      ).toHaveLength(1);

      const columns = dayColumns(await weekPage());
      expect(columns.get('2030-10-11')).not.toContain(`/calendar/${drop}/`);
      expect(columns.get('2030-10-07')).toContain(`/calendar/${keep}/delete`);
    });

    it('answers a native post (no htmx) with a 303 to the week', async () => {
      const outfit = await createOutfit('Native delete');
      const entry = await schedule(outfit, '2030-10-09');
      const res = await t.inject({
        method: 'POST',
        url: `/calendar/${entry}/delete`,
        ...form({ week: '2030-10-09' }),
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/calendar?week=2030-10-09');
      expect(await entryById(entry)).toBeUndefined();
    });

    it('404s an unknown entry', async () => {
      const res = await t.inject({
        method: 'POST',
        url: '/calendar/999999/delete',
        ...form({ week: '2030-10-06' }),
      });
      expect(res.statusCode).toBe(404);
    });

    // #165: production pays a ~114 ms round trip per statement. The session,
    // then begin, the owner lock, the entry's selfie, the entry, commit: no
    // look-up of the entry first (the deletes are the owner's own).
    it('deletes in six statements, and 404s another user’s entry in as many', async () => {
      const outfit = await createOutfit('Counted delete');
      const entry = await schedule(outfit, '2030-10-10');
      const stranger = await t.register('delete-stranger@example.com');
      const refused = await recordQueries(async () => {
        const res = await t.inject({
          method: 'POST',
          url: `/calendar/${entry}/delete`,
          ...form({ week: '2030-10-10' }),
          headers: { ...form({}).headers, cookie: stranger },
        });
        expect(res.statusCode).toBe(404);
      });
      expect(refused.statements).toBe(6);
      expect(await entryById(entry)).toBeDefined();

      const deleted = await recordQueries(async () => {
        const res = await t.inject({
          method: 'POST',
          url: `/calendar/${entry}/delete`,
          ...form({ week: '2030-10-10' }),
        });
        expect(res.statusCode).toBe(303);
      });
      expect(deleted.statements).toBe(6);
      expect(deleted.sql.join('\n')).not.toMatch(/for update/);
      expect(await entryById(entry)).toBeUndefined();
    });

    it('without a body still deletes and sends the page to the current week', async () => {
      const outfit = await createOutfit('Bodiless delete');
      const entry = await schedule(outfit, '2030-10-08');
      const res = await t.inject({
        method: 'POST',
        url: `/calendar/${entry}/delete`,
        headers: { 'hx-request': 'true' },
      });
      expect(res.statusCode).toBe(200);
      expect(hxLocationPath(res)).toBe('/calendar');
      expect(await entryById(entry)).toBeUndefined();
    });

    it('rejects a malformed week or id with a 400 and deletes nothing', async () => {
      const outfit = await createOutfit('Malformed delete');
      const entry = await schedule(outfit, '2030-10-08');
      for (const [url, fields] of [
        [`/calendar/${entry}/delete`, { week: 'garbage' }],
        ['/calendar/abc/delete', { week: '2030-10-08' }],
        ['/calendar/0/delete', { week: '2030-10-08' }],
      ] as const) {
        const res = await t.inject({ method: 'POST', url, ...form(fields) });
        expect({ url, status: res.statusCode }).toEqual({ url, status: 400 });
      }
      expect(await entryById(entry)).toBeDefined();
    });
  });

  // Marking worn is for days up to today (a planned day cannot be worn yet),
  // so these entries sit on a Wednesday in 2020. The wears marking writes
  // are covered in wears.spec.ts.
  describe('POST /calendar/:id/worn', () => {
    const PAST = '2020-10-07';

    const post = (
      id: number,
      options: { htmx: boolean; worn?: '1' | '0'; week?: string },
    ) =>
      t.inject({
        method: 'POST',
        url: `/calendar/${id}/worn`,
        ...form({
          week: options.week ?? PAST,
          ...(options.worn && { worn: options.worn }),
        }),
        headers: {
          ...form({}).headers,
          ...(options.htmx ? { 'hx-request': 'true' } : {}),
        },
      });

    const wornAt = async (id: number) => (await entryById(id))!.wornAt;

    it('marks worn and not worn as the pill asks, answering htmx with the swapped pill', async () => {
      const outfit = await createOutfit('Worn pill');
      const entry = await schedule(outfit, PAST);

      const on = await post(entry, { htmx: true, worn: '1' });
      expect(on.statusCode).toBe(200);
      expect(on.body).not.toContain('<html');
      expect(on.body).toContain(`hx-post="/calendar/${entry}/worn"`);
      expect(on.body).toContain('bg-success');
      expect(hasText(on.body, '✓ Worn')).toBe(true);
      // The swapped pill asks for the other state next.
      expect(on.body).toContain('name="worn" value="0"');
      const stamped = await wornAt(entry);
      expect(stamped).toBeInstanceOf(Date);
      expect(Math.abs(Date.now() - stamped!.getTime())).toBeLessThan(60_000);

      const wednesday = dayColumns(
        await weekPage(`/calendar?week=${PAST}`),
      ).get(PAST)!;
      const button = wednesday.slice(
        wednesday.indexOf(`action="/calendar/${entry}/worn"`),
      );
      expect(button).toMatch(/bg-success[\s\S]*✓ Worn/);

      // A double tap (or a replayed post) asks for worn again: still worn,
      // the first instant kept.
      const again = await post(entry, { htmx: true, worn: '1' });
      expect(again.body).toContain('bg-success');
      expect(await wornAt(entry)).toEqual(stamped);

      const off = await post(entry, { htmx: true, worn: '0' });
      expect(off.body).not.toContain('bg-success');
      expect(hasText(off.body, 'Worn?')).toBe(true);
      expect(await wornAt(entry)).toBeNull();
    });

    // #165: the session, then begin, the owner lock, the entry locked and
    // read, the change and its wears together (one statement each way),
    // commit.
    it('marks worn, and not worn, in six statements each', async () => {
      const outfit = await createOutfit('Counted worn');
      const entry = await schedule(outfit, PAST);
      const on = await recordQueries(() =>
        post(entry, { htmx: true, worn: '1' }),
      );
      expect(on.statements).toBe(6);
      expect(await wornAt(entry)).toBeInstanceOf(Date);
      const off = await recordQueries(() =>
        post(entry, { htmx: true, worn: '0' }),
      );
      expect(off.statements).toBe(6);
      expect(await wornAt(entry)).toBeNull();
    });

    it('redirects a plain form post back to the week', async () => {
      const outfit = await createOutfit('Worn redirect');
      const entry = await schedule(outfit, PAST);

      const res = await post(entry, { htmx: false, worn: '1' });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(`/calendar?week=${PAST}`);
      expect(await wornAt(entry)).toBeInstanceOf(Date);
    });

    it('404s an unknown entry', async () => {
      expect((await post(999_999, { htmx: true, worn: '1' })).statusCode).toBe(
        404,
      );
    });

    it('without `worn` (a pill cached before it posted one) toggles', async () => {
      const outfit = await createOutfit('Cached pill');
      const entry = await schedule(outfit, PAST);

      await post(entry, { htmx: true });
      expect(await wornAt(entry)).toBeInstanceOf(Date);
      await post(entry, { htmx: true });
      expect(await wornAt(entry)).toBeNull();
    });

    it('without a body toggles, and redirects a plain post to the current week', async () => {
      const outfit = await createOutfit('Bodiless worn');
      const entry = await schedule(outfit, PAST);

      const htmx = await t.inject({
        method: 'POST',
        url: `/calendar/${entry}/worn`,
        headers: { 'hx-request': 'true' },
      });
      expect(htmx.statusCode).toBe(200);
      expect(htmx.body).toContain(`hx-post="/calendar/${entry}/worn"`);
      expect(htmx.body).not.toContain('name="week"');
      expect(await wornAt(entry)).toBeInstanceOf(Date);

      const plain = await t.inject({
        method: 'POST',
        url: `/calendar/${entry}/worn`,
      });
      expect(plain.statusCode).toBe(303);
      expect(plain.headers.location).toBe('/calendar');
      expect(await wornAt(entry)).toBeNull();
    });

    it('refuses to mark a planned day worn, and shows its chip no pill', async () => {
      const outfit = await createOutfit('Planned');
      const entry = await schedule(outfit, '2030-10-09');

      const res = await post(entry, {
        htmx: true,
        worn: '1',
        week: '2030-10-09',
      });
      expect(res.statusCode).toBe(409);
      expect(await wornAt(entry)).toBeNull();

      const wednesday = dayColumns(await weekPage()).get('2030-10-09')!;
      expect(wednesday).toContain(`/calendar/${entry}/delete`);
      expect(wednesday).not.toContain(`/calendar/${entry}/worn`);
    });

    it('rejects a `worn` that is neither 1 nor 0', async () => {
      const outfit = await createOutfit('Bad worn');
      const entry = await schedule(outfit, PAST);
      const res = await t.inject({
        method: 'POST',
        url: `/calendar/${entry}/worn`,
        ...form({ worn: 'yes' }),
      });
      expect(res.statusCode).toBe(400);
      expect(await wornAt(entry)).toBeNull();
    });
  });
});
