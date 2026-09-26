import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garment, garmentWear, outfitCalendar } from '../../src/db/schema';
import {
  type AwayReason,
  isAvailable,
  washLimit,
  wearsSinceWash,
} from '../../src/wardrobe/availability';
import {
  addDays,
  type IsoDate,
  todayIn,
} from '../../src/web/calendar/calendar-date';
import { availableGarment, dirtyCopiesSql } from '../../src/web/wears/queries';
import { createGarment } from './garments';
import {
  createTestApp,
  hasText,
  type TestApp,
  unescapeHtml,
  userIdOf,
} from './harness';
import { expectFragment, expectFullPage } from './pages';

/**
 * Wears and washes (#7, plan section 1): the wear log that outfit edits
 * cannot rewrite, counted by distinct day; Wore today; Washed and the
 * laundry page; multiples; away; and the "available" rule, in SQL and in
 * TypeScript, agreeing. The owner's own records throughout: a grantee sees
 * none of it (the refusals are in authorization.spec.ts).
 */

const form = (fields: Record<string, string | string[]>) => {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of [value].flat()) body.append(name, item);
  }
  return {
    payload: body.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  };
};

describe('wears and washes', () => {
  let t: TestApp;
  // The app's "today": APP_TIMEZONE defaults to New York.
  const today = () => todayIn('America/New_York', new Date());
  const daysAgo = (days: number) => addDays(today(), -days);

  /** POST /wardrobe with the care fields; the new garment's id. */
  const newGarment = async (
    name: string,
    category: string,
    care: { quantity?: number; washAfterWears?: string } = {},
    cookie?: string,
  ) => {
    const res = await t.inject({
      method: 'POST',
      url: '/wardrobe',
      ...form({
        name,
        category,
        care: '1',
        quantity: String(care.quantity ?? 1),
        washAfterWears: care.washAfterWears ?? '',
      }),
      ...(cookie && {
        headers: {
          ...form({}).headers,
          cookie,
        },
      }),
    });
    expect(res.statusCode).toBe(302);
    return Number(
      /^\/wardrobe\/(\d+)\?/.exec(String(res.headers.location))![1],
    );
  };

  /** POST /outfits with one slot per garment; the outfit's id. */
  const newOutfit = async (name: string, garmentIds: number[]) => {
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

  const editOutfit = async (outfitId: number, garmentIds: number[]) => {
    const res = await t.inject({
      method: 'POST',
      url: `/outfits/${outfitId}`,
      ...form({
        category: garmentIds.map(() => 'tops'),
        garmentId: garmentIds.map(String),
      }),
    });
    expect(res.statusCode).toBe(302);
  };

  /** Plans the outfit on `day` and returns the entry's id. */
  const schedule = async (outfitId: number, day: IsoDate) => {
    const res = await t.inject({
      method: 'POST',
      url: '/calendar',
      ...form({ outfitId: String(outfitId), date: day }),
    });
    expect(res.statusCode).toBe(302);
    const [entry] = await t.db
      .select({ id: outfitCalendar.id })
      .from(outfitCalendar)
      .where(
        and(eq(outfitCalendar.outfitId, outfitId), eq(outfitCalendar.day, day)),
      );
    return entry.id;
  };

  const markWorn = async (entryId: number, worn: '1' | '0' = '1') => {
    const res = await t.inject({
      method: 'POST',
      url: `/calendar/${entryId}/worn`,
      ...form({ worn }),
    });
    expect(res.statusCode).toBe(303);
  };

  /** A garment's wear rows as (day, entry) pairs, oldest first. */
  const wearsOf = async (garmentId: number) =>
    t.db
      .select({ day: garmentWear.day, entry: garmentWear.outfitCalendarId })
      .from(garmentWear)
      .where(eq(garmentWear.garmentId, garmentId))
      .orderBy(asc(garmentWear.day), asc(garmentWear.id));

  const garmentPage = async (id: number, cookie?: string, query = '') => {
    const res = await t.inject({
      method: 'GET',
      url: `/wardrobe/${id}${query}`,
      ...(cookie && { headers: { cookie } }),
    });
    expect(res.statusCode).toBe(200);
    return res;
  };

  const post = (
    url: string,
    fields: Record<string, string> = {},
    htmx = true,
  ) =>
    t.inject({
      method: 'POST',
      url,
      ...form(fields),
      headers: {
        ...form({}).headers,
        ...(htmx ? { 'hx-request': 'true' } : {}),
      },
    });

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  describe('the calendar entry’s wears', () => {
    it('snapshots the outfit’s garments when the entry is marked worn; an outfit edit never changes them', async () => {
      const tee = await newGarment('Snapshot tee', 'tops');
      const shirt = await newGarment('Snapshot shirt', 'tops');
      const other = await newGarment('Swapped-in tee', 'tops');
      const outfit = await newOutfit('Snapshot', [tee, shirt]);
      const entry = await schedule(outfit, daysAgo(3));

      await markWorn(entry);
      expect(await wearsOf(tee)).toEqual([{ day: daysAgo(3), entry }]);
      expect(await wearsOf(shirt)).toEqual([{ day: daysAgo(3), entry }]);

      // Swap the shirt out: March's wears stay with the shirt.
      await editOutfit(outfit, [tee, other]);
      expect(await wearsOf(shirt)).toEqual([{ day: daysAgo(3), entry }]);
      expect(await wearsOf(other)).toEqual([]);
      expect(hasText((await garmentPage(shirt)).body, 'Worn once')).toBe(true);
      expect(hasText((await garmentPage(other)).body, 'Not worn yet')).toBe(
        true,
      );
      expect(t.logs.messages('info', 'Web')).toContainEqual(
        expect.stringMatching(
          new RegExp(
            `^Calendar entry ${entry} marked worn by user \\d+ \\(2 wears logged\\)$`,
          ),
        ),
      );
    });

    it('unmarking removes exactly that entry’s wears', async () => {
      const tee = await newGarment('Unmark tee', 'tops');
      const outfit = await newOutfit('Unmark', [tee]);
      const kept = await schedule(outfit, daysAgo(5));
      const undone = await schedule(outfit, daysAgo(4));
      await markWorn(kept);
      await markWorn(undone);
      expect(await wearsOf(tee)).toHaveLength(2);

      await markWorn(undone, '0');
      expect(await wearsOf(tee)).toEqual([{ day: daysAgo(5), entry: kept }]);
    });

    it('deleting an entry removes exactly its wears', async () => {
      const tee = await newGarment('Delete tee', 'tops');
      const outfit = await newOutfit('Delete', [tee]);
      const kept = await schedule(outfit, daysAgo(6));
      const deleted = await schedule(outfit, daysAgo(2));
      await markWorn(kept);
      await markWorn(deleted);

      const res = await t.inject({
        method: 'POST',
        url: `/calendar/${deleted}/delete`,
      });
      expect(res.statusCode).toBe(303);
      expect(await wearsOf(tee)).toEqual([{ day: daysAgo(6), entry: kept }]);
    });

    it('counts two entries on one day with the same garment as one wear', async () => {
      const tee = await newGarment('Twice tee', 'tops');
      const morning = await newOutfit('Morning', [tee]);
      const evening = await newOutfit('Evening', [tee]);
      await markWorn(await schedule(morning, daysAgo(1)));
      await markWorn(await schedule(evening, daysAgo(1)));

      expect(await wearsOf(tee)).toHaveLength(2);
      const page = await garmentPage(tee);
      expect(hasText(page.body, 'Worn once')).toBe(true);
      expect(hasText(page.body, 'last worn yesterday')).toBe(true);
    });

    it('counts a garment held in two slots of one outfit once', async () => {
      const tee = await newGarment('Two-slot tee', 'tops');
      const outfit = await newOutfit('Two slots', [tee, tee]);
      await markWorn(await schedule(outfit, daysAgo(2)));
      expect(await wearsOf(tee)).toHaveLength(1);
    });
  });

  describe('deleting an outfit', () => {
    const deleteOutfit = async (outfitId: number) => {
      const res = await t.inject({
        method: 'DELETE',
        url: `/outfits/${outfitId}`,
        headers: { 'hx-request': 'true' },
      });
      expect(res.statusCode).toBe(200);
    };

    it('keeps the days it was worn as day-level wears, with the counts and last worn', async () => {
      const tee = await newGarment('Deleted-outfit tee', 'tops');
      const outfit = await newOutfit('Short-lived', [tee]);
      await markWorn(await schedule(outfit, daysAgo(9)));
      await markWorn(await schedule(outfit, daysAgo(4)));
      const before = unescapeHtml((await garmentPage(tee)).body);
      expect(hasText(before, 'Worn 2 times')).toBe(true);
      expect(hasText(before, 'last worn 4 days ago')).toBe(true);

      await deleteOutfit(outfit);

      expect(await wearsOf(tee)).toEqual([
        { day: daysAgo(9), entry: null },
        { day: daysAgo(4), entry: null },
      ]);
      const after = unescapeHtml((await garmentPage(tee)).body);
      expect(hasText(after, 'Worn 2 times')).toBe(true);
      expect(hasText(after, 'last worn 4 days ago')).toBe(true);
      expect(t.logs.messages('info', 'Web')).toContainEqual(
        expect.stringMatching(
          new RegExp(
            `^Outfit ${outfit} deleted by user \\d+ \\(2 wears kept as day-level wears\\)$`,
          ),
        ),
      );
    });

    it('keeps one wear where the garment was also logged alone that day', async () => {
      const tee = await newGarment('Both today tee', 'tops');
      await post(`/wardrobe/${tee}/wear`, { worn: '1' });
      const outfit = await newOutfit('Today too', [tee]);
      await markWorn(await schedule(outfit, today()));
      expect(await wearsOf(tee)).toHaveLength(2);

      await deleteOutfit(outfit);

      expect(await wearsOf(tee)).toEqual([{ day: today(), entry: null }]);
    });

    it('keeps the wears of a garment taken out of the outfit before it was deleted', async () => {
      const shirt = await newGarment('Removed-then-deleted shirt', 'tops');
      const other = await newGarment('Stayed tee', 'tops');
      const outfit = await newOutfit('Edited, then deleted', [shirt, other]);
      await markWorn(await schedule(outfit, daysAgo(3)));
      await editOutfit(outfit, [other]);

      await deleteOutfit(outfit);

      expect(await wearsOf(shirt)).toEqual([{ day: daysAgo(3), entry: null }]);
      expect(await wearsOf(other)).toEqual([{ day: daysAgo(3), entry: null }]);
    });

    it('leaves an unworn outfit’s deletion as it was: no wears appear', async () => {
      const tee = await newGarment('Never worn tee', 'tops');
      const outfit = await newOutfit('Planned only', [tee]);
      await schedule(outfit, daysAgo(2));
      await deleteOutfit(outfit);
      expect(await wearsOf(tee)).toEqual([]);
    });

    it('never lets "Wore today"’s undo take a kept wear from another day', async () => {
      const tee = await newGarment('Kept history tee', 'tops');
      const outfit = await newOutfit('Gone', [tee]);
      await markWorn(await schedule(outfit, daysAgo(2)));
      await deleteOutfit(outfit);

      // The undo only ever deletes today's day-level wear.
      await post(`/wardrobe/${tee}/wear`, { worn: '0' });
      expect(await wearsOf(tee)).toEqual([{ day: daysAgo(2), entry: null }]);
    });
  });

  describe('Wore today', () => {
    it('logs one wear today, once however often it is tapped, and undoes it the same day', async () => {
      const tee = await newGarment('Today tee', 'tops');

      const first = await post(`/wardrobe/${tee}/wear`, { worn: '1' });
      expectFragment(first);
      expect(first.body).toContain('id="garment-wear"');
      expect(hasText(first.body, 'Worn once')).toBe(true);
      expect(hasText(first.body, 'Undo “Wore today”')).toBe(true);
      await post(`/wardrobe/${tee}/wear`, { worn: '1' });
      expect(await wearsOf(tee)).toEqual([{ day: today(), entry: null }]);

      const undo = await post(`/wardrobe/${tee}/wear`, { worn: '0' });
      expect(hasText(undo.body, 'Not worn yet')).toBe(true);
      expect(await wearsOf(tee)).toEqual([]);
    });

    it('redirects a plain post back to the garment', async () => {
      const tee = await newGarment('Plain wear tee', 'tops');
      const res = await post(`/wardrobe/${tee}/wear`, { worn: '1' }, false);
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(`/wardrobe/${tee}`);
    });

    it('says a worn calendar entry today wore it, instead of offering a second wear', async () => {
      const tee = await newGarment('Entry today tee', 'tops');
      await markWorn(await schedule(await newOutfit('Today', [tee]), today()));
      const page = await garmentPage(tee);
      expect(hasText(page.body, 'Worn today (calendar)')).toBe(true);
      expect(page.body).not.toContain(`/wardrobe/${tee}/wear`);
    });
  });

  describe('washing', () => {
    it('Washed resets the wears since the wash; a wear on the wash day counts before it', async () => {
      const jeans = await newGarment('Wash jeans', 'bottoms');
      const outfit = await newOutfit('Jeans days', [jeans]);
      for (const days of [3, 2, 1]) {
        await markWorn(await schedule(outfit, daysAgo(days)));
      }
      await post(`/wardrobe/${jeans}/wear`, { worn: '1' });
      // Bottoms: 3 wears a wash. Four days: dirty.
      let page = unescapeHtml((await garmentPage(jeans)).body);
      expect(hasText(page, 'Worn 4 times · 4 since washed')).toBe(true);
      expect(hasText(page, 'Needs a wash')).toBe(true);

      const washed = await post(`/wardrobe/${jeans}/washed`);
      expectFragment(washed);
      const [row] = await t.db
        .select({ lastWashedOn: garment.lastWashedOn })
        .from(garment)
        .where(eq(garment.id, jeans));
      expect(row.lastWashedOn).toBe(today());
      page = unescapeHtml(washed.body);
      // Today's wear was before the wash: nothing since.
      expect(hasText(page, 'Worn 4 times · 0 since washed')).toBe(true);
      expect(hasText(page, 'Needs a wash')).toBe(false);
      expect(hasText(page, 'Last washed today')).toBe(true);
    });

    it('counts copies: three tees are three wears, "1 of 3 need a wash" until the last', async () => {
      const tees = await newGarment('Three tees', 'tops', { quantity: 3 });
      const outfit = await newOutfit('Tee days', [tees]);
      await markWorn(await schedule(outfit, daysAgo(3)));

      const laundry = await t.inject({ method: 'GET', url: '/laundry' });
      expectFullPage(laundry);
      expect(hasText(laundry.body, '1 of 3 need a wash')).toBe(true);
      const grid = await t.inject({
        method: 'GET',
        url: '/wardrobe?needsWash=true',
      });
      expect(grid.body).toContain('Three tees');
      expect(hasText(grid.body, '×3')).toBe(true);
      expect(hasText(grid.body, 'Wash 1/3')).toBe(true);

      await markWorn(await schedule(outfit, daysAgo(2)));
      await markWorn(await schedule(outfit, daysAgo(1)));
      const page = await garmentPage(tees);
      expect(hasText(page.body, '3 of 3 need a wash')).toBe(true);
    });

    it('lists the hamper on /laundry and washes the checked ones, the user’s own only', async () => {
      const shirt = await newGarment('Hamper shirt', 'tops');
      const chinos = await newGarment('Hamper chinos', 'bottoms');
      const shoes = await newGarment('Hamper shoes', 'footwear');
      const outfit = await newOutfit('Hamper', [shirt, chinos, shoes]);
      await markWorn(await schedule(outfit, daysAgo(1)));

      const page = unescapeHtml(
        (await t.inject({ method: 'GET', url: '/laundry' })).body,
      );
      // The shirt is due (checked), the chinos worn but not due (unchecked);
      // shoes are never laundered.
      expect(page).toMatch(
        new RegExp(`name="ids" value="${shirt}" checked=""`),
      );
      expect(page).toContain(`name="ids" value="${chinos}"`);
      expect(page).not.toMatch(
        new RegExp(`name="ids" value="${chinos}" checked`),
      );
      expect(page).not.toContain('Hamper shoes');

      const stranger = await t.register('laundry-stranger@example.com');
      const theirs = await newGarment('Not yours', 'tops', {}, stranger);
      const res = await t.inject({
        method: 'POST',
        url: '/laundry',
        ...form({ ids: [String(shirt), String(theirs)] }),
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/laundry?washed=1');
      const washed = await t.db
        .select({ id: garment.id, lastWashedOn: garment.lastWashedOn })
        .from(garment)
        .where(sql`${garment.id} in (${shirt}, ${chinos}, ${theirs})`)
        .orderBy(garment.id);
      expect(washed).toEqual([
        { id: shirt, lastWashedOn: today() },
        { id: chinos, lastWashedOn: null },
        { id: theirs, lastWashedOn: null },
      ]);
      const after = await t.inject({ method: 'GET', url: '/laundry?washed=1' });
      expect(hasText(after.body, '1 washed')).toBe(true);
      expect(unescapeHtml(after.body)).not.toContain(
        `name="ids" value="${shirt}"`,
      );
    });

    it('prompts the owner from the wardrobe when something needs a wash', async () => {
      const grid = await t.inject({ method: 'GET', url: '/wardrobe' });
      expect(grid.body).toMatch(/\d+ garments need a wash/);
      expect(grid.body).toContain('href="/laundry"');
    });

    it('shows an empty hamper to someone who wore nothing', async () => {
      const cookie = await t.register('laundry-empty@example.com');
      const res = await t.inject({
        method: 'GET',
        url: '/laundry',
        headers: { cookie },
      });
      expectFullPage(res);
      expect(hasText(res.body, 'Nothing needs a wash.')).toBe(true);
    });
  });

  describe('away', () => {
    it('lends a garment with a note, takes it off the available list, and brings it back', async () => {
      const jacket = await newGarment('Lent jacket', 'outerwear');
      const lent = await post(`/wardrobe/${jacket}/away`, {
        away: 'lent',
        awayNote: '  Dana has it  ',
      });
      expectFragment(lent);
      expect(lent.body).toContain('value="Dana has it"');
      const [row] = await t.db
        .select({ away: garment.away, awayNote: garment.awayNote })
        .from(garment)
        .where(eq(garment.id, jacket));
      expect(row).toEqual({ away: 'lent', awayNote: 'Dana has it' });
      expect(await available(jacket)).toBe(false);
      const grid = await t.inject({ method: 'GET', url: '/wardrobe' });
      expect(grid.body).toContain('>Lent</span>');

      await post(`/wardrobe/${jacket}/away`, { away: '', awayNote: 'stale' });
      const [back] = await t.db
        .select({ away: garment.away, awayNote: garment.awayNote })
        .from(garment)
        .where(eq(garment.id, jacket));
      expect(back).toEqual({ away: null, awayNote: null });
      expect(await available(jacket)).toBe(true);
    });

    it('refuses a reason that is not lent or repair, and a note without one in the database', async () => {
      const jacket = await newGarment('Bad away jacket', 'outerwear');
      expect(
        (await post(`/wardrobe/${jacket}/away`, { away: 'stolen' })).statusCode,
      ).toBe(400);
      await expect(
        t.db
          .update(garment)
          .set({ awayNote: 'orphan note' })
          .where(eq(garment.id, jacket)),
      ).rejects.toMatchObject({
        cause: { code: '23514', constraint: 'garment_away_note_check' },
      });
    });
  });

  /** Whether availableGarment (SQL) lets the garment through. */
  const available = async (id: number) =>
    (
      await t.db
        .select({ id: garment.id })
        .from(garment)
        .where(and(eq(garment.id, id), availableGarment()))
    ).length === 1;

  describe('the available rule', () => {
    interface Case {
      name: string;
      category: string;
      quantity: number;
      washAfterWears: string;
      /** Days ago worn; one row each (repeats: two entries that day). */
      worn: number[];
      washedDaysAgo: number | null;
      away: AwayReason | null;
      archived: boolean;
    }

    const base: Omit<Case, 'name'> = {
      category: 'tops',
      quantity: 1,
      washAfterWears: '',
      worn: [],
      washedDaysAgo: null,
      away: null,
      archived: false,
    };

    const CASES: Case[] = [
      { ...base, name: 'clean tee' },
      { ...base, name: 'worn tee', worn: [1] },
      { ...base, name: 'washed after wear', worn: [2], washedDaysAgo: 1 },
      { ...base, name: 'worn on wash day', worn: [1], washedDaysAgo: 1 },
      { ...base, name: 'three tees, two worn', quantity: 3, worn: [1, 2] },
      { ...base, name: 'three tees, all worn', quantity: 3, worn: [1, 2, 3] },
      { ...base, name: 'same day twice', quantity: 2, worn: [1, 1] },
      { ...base, name: 'jeans twice', category: 'bottoms', worn: [1, 2] },
      { ...base, name: 'jeans thrice', category: 'bottoms', worn: [1, 2, 3] },
      {
        ...base,
        name: 'raw denim',
        category: 'bottoms',
        washAfterWears: '0',
        worn: [1, 2, 3, 4, 5],
      },
      { ...base, name: 'sweater once', washAfterWears: '2', worn: [1] },
      { ...base, name: 'sneakers', category: 'footwear', worn: [1, 2, 3] },
      {
        ...base,
        name: 'socks',
        category: 'accessories',
        washAfterWears: '1',
        worn: [1],
      },
      { ...base, name: 'custom', category: 'scrubs', worn: [1, 2] },
      { ...base, name: 'lent', away: 'lent' },
      { ...base, name: 'at repair', away: 'repair' },
      { ...base, name: 'archived', archived: true },
    ];

    it('agrees in SQL (availableGarment, dirtyCopiesSql) and in TypeScript (isAvailable) on every case', async () => {
      const cookie = await t.register('rules@example.com');
      const ownerId = await userIdOf(t, 'rules@example.com');
      const ids = new Map<string, number>();
      for (const c of CASES) {
        const id = await newGarment(
          c.name,
          c.category,
          { quantity: c.quantity, washAfterWears: c.washAfterWears },
          cookie,
        );
        ids.set(c.name, id);
        await t.db
          .update(garment)
          .set({
            lastWashedOn:
              c.washedDaysAgo === null ? null : daysAgo(c.washedDaysAgo),
            away: c.away,
            archived: c.archived,
          })
          .where(eq(garment.id, id));
        // Straight rows: one per wear, repeats standing in for two entries.
        for (const days of c.worn) {
          await t.db
            .insert(garmentWear)
            .values({
              garmentId: id,
              ownerId,
              day: daysAgo(days),
              outfitCalendarId: null,
            })
            .onConflictDoNothing();
        }
      }
      const rows = await t.db
        .select({
          id: garment.id,
          dirty: dirtyCopiesSql(),
          available: sql<boolean>`${availableGarment()}`,
        })
        .from(garment)
        .where(eq(garment.ownerId, ownerId))
        .orderBy(desc(garment.id));
      const bySql = new Map(rows.map((row) => [row.id, row]));

      const expected = CASES.map((c) => {
        const days = c.worn.map(daysAgo);
        const state = {
          quantity: c.quantity,
          limit: washLimit(
            c.category,
            c.washAfterWears === '' ? null : Number(c.washAfterWears),
          ),
          wearsSinceWash: wearsSinceWash(
            days,
            c.washedDaysAgo === null ? null : daysAgo(c.washedDaysAgo),
          ),
        };
        return {
          name: c.name,
          available: isAvailable({
            ...state,
            archived: c.archived,
            away: c.away,
          }),
        };
      });
      const actual = CASES.map((c) => ({
        name: c.name,
        available: bySql.get(ids.get(c.name)!)!.available,
      }));
      expect(actual).toEqual(expected);
      // And the rule reads as the plan says, spelled out.
      expect(
        Object.fromEntries(actual.map((a) => [a.name, a.available])),
      ).toEqual({
        'clean tee': true,
        'worn tee': false,
        'washed after wear': true,
        'worn on wash day': true,
        'three tees, two worn': true,
        'three tees, all worn': false,
        'same day twice': true,
        'jeans twice': true,
        'jeans thrice': false,
        'raw denim': true,
        'sweater once': true,
        sneakers: true,
        socks: false,
        custom: true,
        lent: false,
        'at repair': false,
        archived: false,
      });
    });
  });

  describe('the garment form’s care fields', () => {
    const garmentRow = async (id: number) =>
      (
        await t.db
          .select({
            quantity: garment.quantity,
            washAfterWears: garment.washAfterWears,
            condition: garment.condition,
            conditionNote: garment.conditionNote,
          })
          .from(garment)
          .where(eq(garment.id, id))
      )[0];

    it('saves copies, the wash limit and the condition, and shows them back in the form', async () => {
      const id = await createGarment(t, {
        name: 'Care form',
        category: 'bottoms',
      });
      const res = await t.inject({
        method: 'POST',
        url: `/wardrobe/${id}`,
        ...form({
          category: 'bottoms',
          care: '1',
          quantity: '2',
          washAfterWears: '0',
          condition: 'needs_repair',
          conditionNote: ' Belt loop torn ',
        }),
      });
      expect(res.statusCode).toBe(302);
      expect(await garmentRow(id)).toEqual({
        quantity: 2,
        washAfterWears: 0,
        condition: 'needs_repair',
        conditionNote: 'Belt loop torn',
      });
      const edit = unescapeHtml(
        (await t.inject({ method: 'GET', url: `/wardrobe/${id}/edit` })).body,
      );
      expect(edit).toContain('name="care" value="1"');
      expect(edit).toMatch(/name="quantity"[^>]*value="2"/);
      expect(edit).toMatch(/<option value="0" selected="">Never<\/option>/);
      expect(edit).toMatch(/value="needs_repair"[^>]*checked=""/);
    });

    it('leaves them alone when a form cached before them saves', async () => {
      const id = await newGarment('Old form', 'tops', { quantity: 3 });
      await t.inject({
        method: 'POST',
        url: `/wardrobe/${id}`,
        ...form({ name: 'Old form, renamed', category: 'tops' }),
      });
      expect(await garmentRow(id)).toMatchObject({ quantity: 3 });
    });

    it.each(['0', '31', 'two', '1.5'])(
      're-renders the form with a message for %s copies',
      async (quantity) => {
        const res = await t.inject({
          method: 'POST',
          url: '/wardrobe',
          ...form({ name: 'Bad count', category: 'tops', care: '1', quantity }),
        });
        expect(res.statusCode).toBe(400);
        expect(
          hasText(res.body, 'Copies must be a whole number from 1 to 30'),
        ).toBe(true);
      },
    );

    it('drops a condition note while the garment is good', async () => {
      const id = await createGarment(t, {
        name: 'Good note',
        category: 'tops',
      });
      await t.inject({
        method: 'POST',
        url: `/wardrobe/${id}`,
        ...form({
          category: 'tops',
          care: '1',
          condition: 'good',
          conditionNote: 'nothing wrong',
        }),
      });
      expect(await garmentRow(id)).toMatchObject({
        condition: 'good',
        conditionNote: null,
      });
      await expect(
        t.db
          .update(garment)
          .set({ conditionNote: 'orphan' })
          .where(eq(garment.id, id)),
      ).rejects.toMatchObject({
        cause: { code: '23514', constraint: 'garment_condition_note_check' },
      });
      await expect(
        t.db
          .update(garment)
          .set({ condition: 'shabby' as 'good' })
          .where(eq(garment.id, id)),
      ).rejects.toMatchObject({
        cause: { code: '23514', constraint: 'garment_condition_check' },
      });
    });
  });

  describe('condition', () => {
    it('is set from the garment page, and never makes a garment unavailable', async () => {
      const tee = await newGarment('Worn-out tee', 'tops');
      const res = await post(`/wardrobe/${tee}/condition`, {
        condition: 'replace_soon',
        conditionNote: 'Collar gone',
      });
      expectFragment(res);
      expect(res.body).toContain('id="garment-condition"');
      expect(res.body).toContain('value="Collar gone"');
      expect(await available(tee)).toBe(true);

      const grid = await t.inject({
        method: 'GET',
        url: '/wardrobe?attention=true',
      });
      expect(grid.body).toContain('Worn-out tee');
      expect(hasText(grid.body, 'Replace soon')).toBe(true);
      expect(grid.body).not.toContain('Lent jacket');
    });

    it('is bulk-set on the selected garments, clearing the note only for good', async () => {
      const a = await newGarment('Bulk cond A', 'tops');
      const b = await newGarment('Bulk cond B', 'footwear');
      await post(`/wardrobe/${a}/condition`, {
        condition: 'needs_repair',
        conditionNote: 'Seam',
      });
      const res = await t.inject({
        method: 'POST',
        url: '/wardrobe/bulk',
        ...form({
          ids: [String(a), String(b)],
          property: 'condition',
          condition: 'replace_soon',
        }),
      });
      expect(res.statusCode).toBe(303);
      const rows = await t.db
        .select({ condition: garment.condition, note: garment.conditionNote })
        .from(garment)
        .where(sql`${garment.id} in (${a}, ${b})`)
        .orderBy(garment.id);
      expect(rows).toEqual([
        { condition: 'replace_soon', note: 'Seam' },
        { condition: 'replace_soon', note: null },
      ]);
      await t.inject({
        method: 'POST',
        url: '/wardrobe/bulk',
        ...form({ ids: [String(a)], property: 'condition', condition: 'good' }),
      });
      const [good] = await t.db
        .select({ condition: garment.condition, note: garment.conditionNote })
        .from(garment)
        .where(eq(garment.id, a));
      expect(good).toEqual({ condition: 'good', note: null });
    });
  });

  describe('a shared wardrobe', () => {
    let viewer: string;

    beforeAll(async () => {
      viewer = await t.register('wear-viewer@example.com');
      const invite = await t.inject({
        method: 'POST',
        url: '/wardrobe-share/create-invite-link',
        payload: { permission: 'VIEW' },
        headers: { 'hx-request': 'true' },
      });
      const token = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(
        invite.body,
      )![1];
      await t.inject({
        method: 'POST',
        url: `/wardrobe-share/invite/${token}/accept`,
        headers: { cookie: viewer },
      });
    });

    it('shows a grantee quantity and condition, never wears, washes or away', async () => {
      const tees = await newGarment('Shared tees', 'tops', { quantity: 3 });
      await post(`/wardrobe/${tees}/wear`, { worn: '1' });
      await post(`/wardrobe/${tees}/away`, { away: 'lent', awayNote: 'Sam' });
      await post(`/wardrobe/${tees}/condition`, {
        condition: 'needs_repair',
        conditionNote: 'Hem',
      });
      const q = `?ownerId=${t.owner.id}`;

      const page = await garmentPage(tees, viewer, q);
      expect(page.body).not.toContain('id="garment-wear"');
      expect(hasText(page.body, 'Worn once')).toBe(false);
      expect(page.body).not.toContain('Sam');
      expect(hasText(page.body, 'Needs repair')).toBe(true);
      expect(hasText(page.body, '3 identical')).toBe(true);

      const grid = await t.inject({
        method: 'GET',
        url: `/wardrobe${q}&needsWash=true`,
        headers: { cookie: viewer },
      });
      // The wash filter is dropped for a grantee: the whole wardrobe shows,
      // with no wash marks or away, and the filter is not offered.
      expect(grid.body).toContain('Shared tees');
      expect(hasText(grid.body, 'Wash 1/3')).toBe(false);
      expect(grid.body).not.toContain('>Lent</span>');
      expect(hasText(grid.body, '×3')).toBe(true);
      expect(grid.body).not.toContain('name="needsWash"');
      expect(grid.body).not.toContain('href="/laundry"');

      const own = await garmentPage(tees);
      expect(own.body).toContain('id="garment-wear"');
      expect(own.body).toContain('value="Sam"');
    });
  });
});
