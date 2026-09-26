import { count, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { outfit as outfitTable, outfitCalendar } from '../../src/db/schema';
import { createGarment, jpegPhoto, uploadPhoto } from './garments';
import {
  createTestApp,
  extractImgSrcs,
  hasText,
  hxLocationPath,
  TestApp,
  unescapeHtml,
} from './harness';
import { expectFullPage } from './pages';

/**
 * The calendar page and its writes: the week view renders seven day columns
 * with each entry under its own day, the mini month navigates, and adding,
 * deleting and marking entries worn change exactly the rows they should.
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

/**
 * Each day column's HTML keyed by its YYYY-MM-DD date, in page order. A
 * column ends with its "+ Build outfit" link, which carries the date; the
 * first column starts after the mini month's table.
 */
function dayColumns(html: string): Map<string, string> {
  const columns = new Map<string, string>();
  let start = html.indexOf('</table>');
  for (const match of html.matchAll(
    /href="\/outfits\/new\?scheduleDate=(\d{4}-\d{2}-\d{2})&returnTo=\/calendar"/g,
  )) {
    columns.set(match[1], html.slice(start, match.index));
    start = match.index + match[0].length;
  }
  return columns;
}

/** The rendered day number in a column header. */
function dayNumber(column: string): number {
  return Number(
    /<span class="text-base font-bold[^"]*">\s*(\d+)\s*</.exec(column)?.[1],
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

  /** POST /calendar as the list page's dropdown form sends it (htmx). */
  const schedule = async (outfitId: number, date: string) => {
    const res = await t.inject({
      method: 'POST',
      url: '/calendar',
      ...form({ outfitId: String(outfitId), date }),
      headers: {
        ...form({}).headers,
        'hx-request': 'true',
      },
    });
    expect(res.statusCode).toBe(204);
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
      expect(html).not.toContain('cal-today');
      expect(html).not.toMatch(/text-base font-bold text-primary/);
    });

    it('renders the mini month for the week, highlighting the week and linking every row', async () => {
      const html = await weekPage();
      expect(html).toMatch(/>\s*Oct 2030\s*</);
      // October 2030 starts on a Tuesday: rows start on Sep 29 and run 5 weeks.
      const rowLinks = [
        ...html.matchAll(/href="\/calendar\?week=(\d{4}-\d{2}-\d{2})"/g),
      ].map((m) => m[1]);
      expect([...new Set(rowLinks)]).toEqual([
        '2030-09-29',
        '2030-10-06',
        '2030-10-13',
        '2030-10-20',
        '2030-10-27',
      ]);
      expect(html.match(/cal-in-week/g)).toHaveLength(7);
      // Sep 29-30 and Nov 1-2 pad the grid.
      expect(html.match(/cal-out-month/g)).toHaveLength(4);

      expect(html).toContain(
        'href="/calendar?week=2030-09-01&calMonth=2030-09"',
      );
      expect(html).toContain(
        'href="/calendar?week=2030-10-27&calMonth=2030-11"',
      );
    });

    it('?calMonth= browses the mini month across a year boundary without moving the week', async () => {
      const html = await weekPage(`${WEEK_URL}&calMonth=2031-01`);
      expect(html).toMatch(/>\s*Jan 2031\s*</);
      expect([...dayColumns(html).keys()]).toEqual(WEEK);
      // Dec 1 2030 is a Sunday; Feb 1 2031 is a Saturday.
      expect(html).toContain(
        'href="/calendar?week=2030-12-01&calMonth=2030-12"',
      );
      expect(html).toContain(
        'href="/calendar?week=2031-01-26&calMonth=2031-02"',
      );
    });

    it('without ?week= renders seven consecutive days starting on a Sunday', async () => {
      const dates = [...dayColumns(await weekPage('/calendar')).keys()];
      expect(dates).toHaveLength(7);
      expect(new Date(dates[0]).getUTCDay()).toBe(0);
      dates.forEach((date, i) => {
        expect(new Date(date).getTime() - new Date(dates[0]).getTime()).toBe(
          i * 86_400_000,
        );
      });
    });

    it('an unparseable ?week= falls back to a full week instead of failing', async () => {
      expect(dayColumns(await weekPage('/calendar?week=not-a-date')).size).toBe(
        7,
      );
    });

    it('a malformed ?week= or ?calMonth= falls back to the current week and its month', async () => {
      const current = [...dayColumns(await weekPage('/calendar')).keys()];
      for (const query of [
        'week=2030-02-30',
        'week=2030-10-09T00:00:00Z',
        'calMonth=garbage',
        'calMonth=2030-13',
        'week=garbage&calMonth=2030-00',
      ]) {
        const html = await weekPage(`/calendar?${query}`);
        expect({ query, days: [...dayColumns(html).keys()] }).toEqual({
          query,
          days: current,
        });
      }
      // calMonth alone moves only the mini month.
      const html = await weekPage(`${WEEK_URL}&calMonth=garbage`);
      expect(html).toMatch(/>\s*Oct 2030\s*</);
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
        expect(columns.get('2026-09-25')).toMatch(
          /text-base font-bold text-primary">\s*25\s*</,
        );
        expect(columns.get('2026-09-26')).not.toContain('text-primary');
        expect(html).toMatch(/cal-today">\s*25\s*</);
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
      expect(tuesday).toContain(
        `/outfits/${brunch}/edit?returnTo=/calendar&returnToWeek=2030-10-08`,
      );
      expect(hasText(saturday, 'Untitled Outfit')).toBe(true);
      expect(saturday).toContain(`action="/calendar/${untitledEntry}/worn"`);

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

    it('shows garment thumbnails instead of the name when the outfit has photos', async () => {
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
      expect(thumbs[0]).toMatch(/^\/file\/thumb\/[0-9a-f-]{36}\.webp\?v=1$/);
      // The name only labels the edit link for screen readers.
      expect(hasText(thursday, '>Pictured<')).toBe(false);
      expect(hasText(thursday, 'aria-label="Pictured"')).toBe(true);
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
      for (const htmx of [true, false]) {
        for (let i = 0; i < 2; i++) {
          const res = await t.inject({
            method: 'POST',
            url: '/calendar',
            ...form({ outfitId: String(outfit), date: '2030-10-10' }),
            headers: {
              ...form({}).headers,
              ...(htmx ? { 'hx-request': 'true' } : {}),
            },
          });
          expect(res.statusCode).toBe(htmx ? 204 : 302);
          if (!htmx) {
            expect(res.headers.location).toBe('/calendar?week=2030-10-10');
          }
        }
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

  describe('POST /calendar/:id/worn', () => {
    const toggle = (id: number, htmx: boolean) =>
      t.inject({
        method: 'POST',
        url: `/calendar/${id}/worn`,
        ...form({ week: '2030-10-09' }),
        headers: {
          ...form({}).headers,
          ...(htmx ? { 'hx-request': 'true' } : {}),
        },
      });

    const wornAt = async (id: number) => (await entryById(id))!.wornAt;

    it('toggles worn on and off, answering htmx with the swapped button', async () => {
      const outfit = await createOutfit('Worn toggle');
      const entry = await schedule(outfit, '2030-10-09');

      const on = await toggle(entry, true);
      expect(on.statusCode).toBeLessThan(300);
      expect(on.body).not.toContain('<html');
      expect(on.body).toContain(`hx-post="/calendar/${entry}/worn"`);
      expect(on.body).toContain('bg-success');
      expect(hasText(on.body, '✓ Worn')).toBe(true);
      const stamped = await wornAt(entry);
      expect(stamped).toBeInstanceOf(Date);
      expect(Math.abs(Date.now() - stamped!.getTime())).toBeLessThan(60_000);

      const wednesday = dayColumns(await weekPage()).get('2030-10-09')!;
      const button = wednesday.slice(
        wednesday.indexOf(`action="/calendar/${entry}/worn"`),
      );
      expect(button).toMatch(/bg-success[\s\S]*✓ Worn/);

      const off = await toggle(entry, true);
      expect(off.body).not.toContain('bg-success');
      expect(hasText(off.body, 'Worn?')).toBe(true);
      expect(await wornAt(entry)).toBeNull();
    });

    it('redirects a plain form post back to the week', async () => {
      const outfit = await createOutfit('Worn redirect');
      const entry = await schedule(outfit, '2030-10-09');

      const res = await toggle(entry, false);
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/calendar?week=2030-10-09');
      expect(await wornAt(entry)).toBeInstanceOf(Date);
    });

    it('404s an unknown entry', async () => {
      expect((await toggle(999_999, true)).statusCode).toBe(404);
    });

    it('without a body toggles, and redirects a plain post to the current week', async () => {
      const outfit = await createOutfit('Bodiless worn');
      const entry = await schedule(outfit, '2030-10-09');

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
  });
});
