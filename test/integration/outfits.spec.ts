import { and, asc, count, eq, isNotNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  garment as garmentTable,
  outfit as outfitTable,
  outfitCalendar,
  outfitSlot,
} from '../../src/db/schema';
import { createGarment, jpegPhoto, uploadPhoto } from './garments';
import {
  createTestApp,
  hasText,
  imgTags,
  recordQueries,
  TestApp,
  unescapeHtml,
} from './harness';

/**
 * Outfits end to end: the list, the builder and its prev/next row fragment,
 * create/edit/delete as the builder form posts them (urlencoded, one
 * category + garmentId pair per row), and scheduling from the form. Proves
 * the rendered HTML and the outfit_slot rows agree with what the user built.
 */

/** A saved outfit_slot row, as the tests compare them. */
interface SavedSlot {
  category: string;
  garmentId: number | null;
}

/** One builder row as the form posts it: category plus garment (or none). */
type Slot = [category: string, garmentId: number | null];

interface OutfitFields {
  name?: string;
  notes?: string;
  scheduleDate?: string;
  returnTo?: string;
  returnToWeek?: string;
}

/** The body the outfit form (src/web/outfits/form-page.tsx) submits, in document order. */
function outfitForm(fields: OutfitFields, slots: Slot[]) {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(fields) as [string, string?][]) {
    if (value !== undefined) form.append(key, value);
  }
  for (const [category, garmentId] of slots) {
    form.append('category', category);
    form.append('garmentId', garmentId == null ? '' : String(garmentId));
  }
  return {
    payload: form.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  };
}

const byId = (a: number, b: number) => a - b;
const ascending = (ids: number[]) => [...ids].sort(byId);

function outfitIdFrom(location: unknown): number {
  const target = String(location);
  const match = /^\/outfits\/(\d+)$/.exec(target);
  if (!match) throw new Error(`Unexpected outfit redirect: ${target}`);
  return Number(match[1]);
}

/** Builder rows in document order: `[category, selected garment id]`. */
function formRows(html: string): Slot[] {
  const categories = [...html.matchAll(/name="category" value="([^"]*)"/g)].map(
    (m) => m[1],
  );
  const garmentIds = [
    ...html.matchAll(/name="garmentId"\s+value="([^"]*)"/g),
  ].map((m) => (m[1] ? Number(m[1]) : null));
  expect(garmentIds).toHaveLength(categories.length);
  return categories.map((category, i) => [category, garmentIds[i]]);
}

/** Garment links on the show page, in rendered order. */
function shownGarmentIds(html: string): number[] {
  return [...html.matchAll(/href="\/wardrobe\/(\d+)"/g)].map((m) =>
    Number(m[1]),
  );
}

describe('outfits', () => {
  let t: TestApp;

  const createOutfit = async (
    fields: OutfitFields,
    slots: Slot[],
  ): Promise<number> => {
    const res = await t.inject({
      method: 'POST',
      url: '/outfits',
      ...outfitForm(fields, slots),
    });
    expect(res.statusCode).toBe(302);
    return outfitIdFrom(res.headers.location);
  };

  const updateOutfit = (id: number, fields: OutfitFields, slots: Slot[]) =>
    t.inject({
      method: 'POST',
      url: `/outfits/${id}`,
      ...outfitForm(fields, slots),
    });

  /** The garments an outfit's slots name, ascending (the membership set). */
  const slotGarmentIds = async (outfitId: number): Promise<number[]> =>
    (
      await t.db
        .select({ garmentId: outfitSlot.garmentId })
        .from(outfitSlot)
        .where(
          and(
            eq(outfitSlot.outfitId, outfitId),
            isNotNull(outfitSlot.garmentId),
          ),
        )
    )
      .map((row) => row.garmentId!)
      .sort(byId);

  const savedSlots = (outfitId: number): Promise<SavedSlot[]> =>
    t.db
      .select({
        category: outfitSlot.category,
        garmentId: outfitSlot.garmentId,
      })
      .from(outfitSlot)
      .where(eq(outfitSlot.outfitId, outfitId))
      .orderBy(asc(outfitSlot.position));

  const outfitRow = async (id: number) => {
    const [row] = await t.db
      .select()
      .from(outfitTable)
      .where(eq(outfitTable.id, id));
    return row;
  };

  const outfitCount = async () =>
    (await t.db.select({ n: count() }).from(outfitTable))[0].n;

  const calendarEntries = (outfitId: number) =>
    t.db
      .select()
      .from(outfitCalendar)
      .where(eq(outfitCalendar.outfitId, outfitId))
      .orderBy(asc(outfitCalendar.id));

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  // Runs first, while the wardrobe is still empty.
  it('GET /outfits and /outfits/new show their empty states before any garment exists', async () => {
    const list = await t.inject({ method: 'GET', url: '/outfits' });
    expect(list.statusCode).toBe(200);
    expect(hasText(list.body, 'No outfits yet.')).toBe(true);

    const builder = await t.inject({ method: 'GET', url: '/outfits/new' });
    expect(builder.statusCode).toBe(200);
    expect(
      hasText(
        builder.body,
        'Add some garments to your wardrobe to start building outfits.',
      ),
    ).toBe(true);
    expect(builder.body).not.toContain('action="/outfits"');
  });

  describe('GET /outfits/new (builder)', () => {
    it('renders one row per category in enum order, custom categories last, newest garment preselected', async () => {
      const olderTop = await createGarment(t, {
        name: 'Older top',
        category: 'tops',
      });
      const newerTop = await createGarment(t, {
        name: 'Newer top',
        category: 'tops',
      });
      const jeans = await createGarment(t, {
        name: 'Jeans',
        category: 'bottoms',
      });
      const boots = await createGarment(t, {
        name: 'Boots',
        category: 'footwear',
      });
      const parka = await createGarment(t, {
        name: 'Parka',
        category: 'outerwear',
      });
      const beanie = await createGarment(t, {
        name: 'Beanie',
        category: 'hats',
      });

      const res = await t.inject({ method: 'GET', url: '/outfits/new' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('action="/outfits"');
      expect(hasText(res.body, 'Build an Outfit')).toBe(true);

      expect(formRows(res.body)).toEqual([
        ['outerwear', parka],
        ['tops', newerTop],
        ['bottoms', jeans],
        ['footwear', boots],
        ['hats', beanie],
      ]);
      expect(olderTop).toBeLessThan(newerTop);
      // Every category is offered as an "add row" suggestion.
      for (const category of ['outerwear', 'tops', 'bottoms', 'footwear']) {
        expect(res.body).toContain(`<option value="${category}">`);
      }
    });

    it('prefills the schedule date and the return target from the calendar link', async () => {
      const res = await t.inject({
        method: 'GET',
        url: '/outfits/new?scheduleDate=2026-10-14&returnTo=/calendar',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(/name="scheduleDate"[^>]*value="2026-10-14"/);
      expect(res.body).toContain(
        '<input type="hidden" name="returnTo" value="/calendar"/>',
      );
    });

    it('ignores a malformed schedule date in the link', async () => {
      const res = await t.inject({
        method: 'GET',
        url: '/outfits/new?scheduleDate=2026-02-30',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('2026-02-30');
    });

    it('shows each row as the 400px thumb, the cutout only in the detail modal', async () => {
      const coat = await createGarment(t, {
        name: 'Photo coat',
        category: 'coats',
      });
      await uploadPhoto(t, coat, await jpegPhoto(64, 64));

      const res = await t.inject({ method: 'GET', url: '/outfits/new' });
      const html = unescapeHtml(res.body);
      const row = html.slice(html.indexOf('data-category="coats"'));
      const img = imgTags(row)[0];
      expect(img).toMatch(/src="\/file\/thumb\/[0-9a-f-]+\.webp\?v=1"/);
      expect(img).toMatch(/width="56"/);
      expect(row).toMatch(/data-garment-photo="\/file\/nobg\/[0-9a-f-]+\.webp/);
      // No row loads an original or a cutout as an image.
      for (const src of imgTags(html).map((tag) => /src="([^"]*)"/.exec(tag))) {
        expect(src?.[1] ?? '').not.toMatch(
          /^\/file\/(nobg\/)?[0-9a-f-]+\.webp/,
        );
      }
    });

    // The server audit: the builder loaded every garment to show one per
    // category. Adding garments to a category must change neither the
    // statements the page sends nor the rows they return.
    it('reads one garment per category however many the wardrobe holds', async () => {
      const load = () => t.inject({ method: 'GET', url: '/outfits/new' });
      await load();
      const before = await recordQueries(load);
      const rows = formRows((await load()).body).length;

      for (let i = 0; i < 12; i++) {
        await createGarment(t, { name: `Sock ${i}`, category: 'tops' });
      }
      const after = await recordQueries(load);

      expect(after).toEqual(before);
      // The session's user row plus one row per category shown.
      expect(after.rows).toBeLessThanOrEqual(rows + 1);
      expect(after.statements).toBeLessThanOrEqual(2);
    });
  });

  describe('GET /outfits/row-fragment (prev/next swap)', () => {
    // A category's cycle is newest first, so index 1 is the newest.
    let scarves: number[];

    beforeAll(async () => {
      scarves = [];
      for (const name of ['Scarf 1', 'Scarf 2', 'Scarf 3']) {
        scarves.push(await createGarment(t, { name, category: 'scarves' }));
      }
    });

    const fragment = (query: string) =>
      t.inject({ method: 'GET', url: `/outfits/row-fragment?${query}` });

    const rowState = (html: string) => ({
      index: Number(/data-index="(\d+)"/.exec(html)?.[1]),
      count: Number(/data-count="(\d+)"/.exec(html)?.[1]),
      garmentId: formRows(html)[0][1],
      /** The prev and next buttons' swap URLs, as the browser reads them. */
      links: [...unescapeHtml(html).matchAll(/hx-get="([^"]*)"/g)].map(
        (m) => m[1],
      ),
    });

    it('returns only the row partial with the garment at the requested index', async () => {
      const res = await fragment('category=scarves&index=2');
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('<html');
      expect(res.body.match(/class="outfit-row /g)).toHaveLength(1);

      const row = rowState(res.body);
      expect(row).toMatchObject({ index: 2, count: 3, garmentId: scarves[1] });
      expect(res.body).toContain('data-garment-name="Scarf 2"');
      expect(row.links).toEqual([
        '/outfits/row-fragment?category=scarves&index=1',
        '/outfits/row-fragment?category=scarves&index=3',
      ]);
    });

    it('defaults to the newest garment and wraps past either end through an empty slot', async () => {
      const first = rowState((await fragment('category=scarves')).body);
      expect(first).toMatchObject({ index: 1, garmentId: scarves[2] });
      expect(first.links[0]).toContain('index=0');

      const last = rowState((await fragment('category=scarves&index=3')).body);
      expect(last).toMatchObject({ index: 3, garmentId: scarves[0] });
      expect(last.links[1]).toContain('index=0');

      const empty = rowState((await fragment('category=scarves&index=0')).body);
      expect(empty).toMatchObject({ index: 0, garmentId: null });
      expect(empty.links).toEqual([
        '/outfits/row-fragment?category=scarves&index=3',
        '/outfits/row-fragment?category=scarves&index=1',
      ]);
    });

    it('clamps an out-of-range index', async () => {
      const high = rowState((await fragment('category=scarves&index=99')).body);
      expect(high).toMatchObject({ index: 3, garmentId: scarves[0] });

      const low = rowState((await fragment('category=scarves&index=-4')).body);
      expect(low).toMatchObject({ index: 0, garmentId: null });
    });

    it('renders an empty row for a category with no garments and 400s without one', async () => {
      const unknown = rowState((await fragment('category=capes&index=1')).body);
      expect(unknown).toMatchObject({ index: 0, count: 0, garmentId: null });

      expect((await fragment('index=1')).statusCode).toBe(400);
      expect((await fragment('category=%20&index=1')).statusCode).toBe(400);
    });
  });

  describe('POST /outfits', () => {
    it('stores one slot per row, in order, empty rows included', async () => {
      const top = await createGarment(t, { name: 'Linen', category: 'tops' });
      const pants = await createGarment(t, {
        name: 'Chinos',
        category: 'bottoms',
      });

      const id = await createOutfit({ name: 'Brunch', notes: 'Sunny' }, [
        ['tops', top],
        ['footwear', null],
        ['bottoms', pants],
      ]);

      const outfit = await outfitRow(id);
      expect(outfit.name).toBe('Brunch');
      expect(outfit.notes).toBe('Sunny');
      expect(outfit.ownerId).toBe(t.owner.id);
      expect(outfit.shareableId).toMatch(/^[0-9a-f-]{36}$/);
      expect(await savedSlots(id)).toEqual([
        { category: 'tops', garmentId: top },
        { category: 'footwear', garmentId: null },
        { category: 'bottoms', garmentId: pants },
      ]);
      expect(await calendarEntries(id)).toHaveLength(0);
    });

    it('keeps the row but not a garment id that is not in the wardrobe', async () => {
      const top = await createGarment(t, { name: 'Polo', category: 'tops' });
      const id = await createOutfit({ name: 'Tampered' }, [
        ['tops', top],
        ['bottoms', 999_999],
      ]);
      expect(await savedSlots(id)).toEqual([
        { category: 'tops', garmentId: top },
        { category: 'bottoms', garmentId: null },
      ]);
    });

    it('accepts a single row (scalar fields, not arrays) and an empty outfit', async () => {
      const top = await createGarment(t, { name: 'Tee', category: 'tops' });
      const single = await createOutfit({ name: 'Single' }, [['tops', top]]);
      expect(await savedSlots(single)).toEqual([
        { category: 'tops', garmentId: top },
      ]);

      const empty = await createOutfit({}, []);
      expect(await savedSlots(empty)).toEqual([]);
      // A blank name is no name: the pages say "Untitled Outfit".
      expect((await outfitRow(empty)).name).toBeNull();
    });

    it.each([
      ['a row without its garment id', 'category=tops&name=Unpaired'],
      ['a garment id that is not an id', 'category=tops&garmentId=abc'],
      ['a blank category', 'category=%20&garmentId='],
      ['a name longer than the column', `name=${'x'.repeat(256)}`],
    ])('400s %s and writes nothing', async (_label, payload) => {
      const before = await outfitCount();
      const res = await t.inject({
        method: 'POST',
        url: '/outfits',
        payload,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      expect(res.statusCode).toBe(400);
      expect(await outfitCount()).toBe(before);
    });

    it('schedules the new outfit and returns to that calendar week', async () => {
      const top = await createGarment(t, { name: 'Oxford', category: 'tops' });
      const res = await t.inject({
        method: 'POST',
        url: '/outfits',
        ...outfitForm(
          {
            name: 'Planned',
            scheduleDate: '2026-10-14',
            returnTo: '/calendar',
          },
          [['tops', top]],
        ),
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/calendar?week=2026-10-14');

      const [outfit] = await t.db
        .select({ id: outfitTable.id })
        .from(outfitTable)
        .where(eq(outfitTable.name, 'Planned'));
      const entries = await calendarEntries(outfit.id);
      expect(entries).toHaveLength(1);
      expect(entries[0].day).toBe('2026-10-14');
      expect(entries[0].wornAt).toBeFalsy();
    });

    it('prefers returnToWeek over the schedule date for the calendar redirect', async () => {
      const res = await t.inject({
        method: 'POST',
        url: '/outfits',
        ...outfitForm(
          {
            name: 'Week redirect',
            scheduleDate: '2026-10-15',
            returnTo: '/calendar',
            returnToWeek: '2026-10-11',
          },
          [],
        ),
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/calendar?week=2026-10-11');
    });

    it('rejects an invalid schedule date without saving a half-written outfit', async () => {
      const before = await outfitCount();
      const res = await t.inject({
        method: 'POST',
        url: '/outfits',
        ...outfitForm({ name: 'Bad date', scheduleDate: 'garbage' }, []),
      });
      expect(res.statusCode).toBe(400);
      expect(await outfitCount()).toBe(before);
    });

    // The outfit, its slots and its calendar entry commit together: a
    // failure after the outfit row is written leaves nothing behind.
    it('rolls the outfit back when scheduling it fails', async () => {
      const before = await outfitCount();
      const top = await createGarment(t, {
        name: 'Rollback',
        category: 'tops',
      });
      // A day Postgres rejects but the schema accepts cannot be posted (both
      // use the full-date rule), so break the insert at the database: the
      // calendar table refuses writes for the length of this request.
      await t.db.execute(
        sql`create function refuse_entry() returns trigger language plpgsql as $$ begin raise exception 'refused'; end $$`,
      );
      await t.db.execute(
        sql`create trigger refuse_entry before insert on outfit_calendar for each row execute function refuse_entry()`,
      );
      try {
        const res = await t.inject({
          method: 'POST',
          url: '/outfits',
          ...outfitForm({ name: 'Doomed plan', scheduleDate: '2026-11-02' }, [
            ['tops', top],
          ]),
        });
        expect(res.statusCode).toBe(500);
      } finally {
        await t.db.execute(sql`drop trigger refuse_entry on outfit_calendar`);
        await t.db.execute(sql`drop function refuse_entry()`);
      }
      expect(await outfitCount()).toBe(before);
      const [orphans] = await t.db
        .select({ n: count() })
        .from(outfitSlot)
        .where(eq(outfitSlot.garmentId, top));
      expect(orphans.n).toBe(0);
    });
  });

  describe('GET /outfits and GET /outfits/:id', () => {
    it('lists every outfit with its name, notes and a link to it', async () => {
      const a = await createOutfit({ name: 'Office', notes: 'Mondays' }, []);
      const b = await createOutfit({ name: 'Gym' }, []);

      const res = await t.inject({ method: 'GET', url: '/outfits' });
      expect(res.statusCode).toBe(200);
      for (const [id, name] of [
        [a, 'Office'],
        [b, 'Gym'],
      ] as const) {
        expect(res.body).toContain(
          `<a href="/outfits/${id}" class="card-title text-sm hover:underline truncate">${name}</a>`,
        );
        // The per-card "add to calendar" form schedules this outfit.
        expect(res.body).toContain(
          `<input type="hidden" name="outfitId" value="${id}"/>`,
        );
      }
      expect(hasText(res.body, 'Mondays')).toBe(true);
      expect(hasText(res.body, 'No outfits yet.')).toBe(false);
    });

    it('shows an outfit with its garments, notes and edit/delete actions', async () => {
      const top = await createGarment(t, {
        name: 'Silk top',
        category: 'tops',
      });
      const id = await createOutfit({ name: 'Gala', notes: 'Black tie' }, [
        ['tops', top],
        ['footwear', null],
      ]);

      const res = await t.inject({ method: 'GET', url: `/outfits/${id}` });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(/<h1[^>]*>Gala<\/h1>/);
      expect(hasText(res.body, 'Black tie')).toBe(true);
      expect(shownGarmentIds(res.body)).toEqual([top]);
      expect(hasText(res.body, 'Silk top')).toBe(true);
      expect(res.body).toContain(
        `href="/outfits/${id}/edit?returnTo=/outfits/${id}"`,
      );
      expect(res.body).toContain(`hx-delete="/outfits/${id}"`);
    });

    it('404s an unknown outfit and 400s a non-numeric id', async () => {
      expect(
        (await t.inject({ method: 'GET', url: '/outfits/999999' })).statusCode,
      ).toBe(404);
      expect(
        (await t.inject({ method: 'GET', url: '/outfits/abc/edit' }))
          .statusCode,
      ).toBe(400);
    });

    describe('garment order', () => {
      // Built bottom-up: the saved order is the reverse of creation (id) order.
      let outfitId: number;
      let saved: number[];

      beforeAll(async () => {
        const top = await createGarment(t, {
          name: 'Order top',
          category: 'tops',
        });
        const pants = await createGarment(t, {
          name: 'Order pants',
          category: 'bottoms',
        });
        const shoes = await createGarment(t, {
          name: 'Order shoes',
          category: 'footwear',
        });
        for (const id of [top, pants, shoes]) {
          await uploadPhoto(t, id, await jpegPhoto(64, 64));
        }
        saved = [shoes, pants, top];
        outfitId = await createOutfit({ name: 'Ordered' }, [
          ['footwear', shoes],
          ['bottoms', pants],
          ['tops', top],
        ]);
      });

      it('the edit form restores the saved row order', async () => {
        const res = await t.inject({
          method: 'GET',
          url: `/outfits/${outfitId}/edit`,
        });
        expect(formRows(res.body)).toEqual([
          ['footwear', saved[0]],
          ['bottoms', saved[1]],
          ['tops', saved[2]],
        ]);
      });

      it('the show page renders garments in the saved order', async () => {
        const res = await t.inject({
          method: 'GET',
          url: `/outfits/${outfitId}`,
        });
        expect(shownGarmentIds(res.body)).toEqual(saved);
      });

      it('the list renders garments in the saved order', async () => {
        const res = await t.inject({ method: 'GET', url: '/outfits' });
        const start = res.body.indexOf(`data-outfit-id="${outfitId}"`);
        const end = res.body.indexOf('data-outfit-id="', start + 1);
        const card = res.body.slice(start, end === -1 ? undefined : end);
        const alts = imgTags(card).map((tag) => /alt="([^"]*)"/.exec(tag)?.[1]);
        expect(alts).toEqual(['Order shoes', 'Order pants', 'Order top']);
      });

      it('the calendar shows the garments in the saved order', async () => {
        await t.inject({
          method: 'POST',
          url: '/calendar',
          payload: { date: '2030-11-05', outfitId: String(outfitId) },
        });
        const res = await t.inject({
          method: 'GET',
          url: '/calendar?week=2030-11-05',
        });
        const photos = imgTags(res.body).map(
          (tag) => /src="([^"]*)"/.exec(tag)?.[1],
        );
        const listed = await t.inject({ method: 'GET', url: '/outfits' });
        const start = listed.body.indexOf(`data-outfit-id="${outfitId}"`);
        const card = listed.body.slice(
          start,
          listed.body.indexOf('data-outfit-id="', start + 1),
        );
        const inOrder = imgTags(card).map(
          (tag) => /src="([^"]*)"/.exec(tag)?.[1],
        );
        expect(photos).toEqual(inOrder);
      });

      it('lists outfits newest first, one statement for them all', async () => {
        const load = () => t.inject({ method: 'GET', url: '/outfits' });
        const res = await load();
        const ids = [...res.body.matchAll(/data-outfit-id="(\d+)"/g)].map((m) =>
          Number(m[1]),
        );
        expect(ids.length).toBeGreaterThan(3);
        expect(ids).toEqual([...ids].sort((a, b) => b - a));
        // The session's user row, then every outfit with its garments.
        expect((await recordQueries(load)).statements).toBe(2);
      });
    });
  });

  describe('GET /outfits/:id/edit and POST /outfits/:id', () => {
    it('renders the edit form with the saved values and every row selected', async () => {
      const top = await createGarment(t, { name: 'Knit', category: 'tops' });
      const id = await createOutfit({ name: 'Cosy', notes: 'Fireside' }, [
        ['tops', top],
      ]);

      const res = await t.inject({ method: 'GET', url: `/outfits/${id}/edit` });
      expect(res.statusCode).toBe(200);
      expect(hasText(res.body, 'Edit Outfit')).toBe(true);
      expect(res.body).toContain(`action="/outfits/${id}"`);
      expect(res.body).toMatch(/name="name"[^>]*value="Cosy"/);
      expect(res.body).toMatch(/<textarea[^>]*name="notes"[\s\S]*?Fireside/);
      expect(formRows(res.body)).toEqual([['tops', top]]);
      expect(res.body).toContain(
        `<input type="hidden" name="returnTo" value="/outfits/${id}"/>`,
      );
    });

    it('carries the calendar return target through the edit form', async () => {
      const id = await createOutfit({ name: 'From calendar' }, []);
      const res = await t.inject({
        method: 'GET',
        url: `/outfits/${id}/edit?returnTo=/calendar&returnToWeek=2026-10-11`,
      });
      expect(res.body).toContain(
        '<input type="hidden" name="returnTo" value="/calendar"/>',
      );
      expect(res.body).toContain(
        '<input type="hidden" name="returnToWeek" value="2026-10-11"/>',
      );
    });

    it('replaces membership and order, and updates name and notes', async () => {
      const top = await createGarment(t, { name: 'Tank', category: 'tops' });
      const shorts = await createGarment(t, {
        name: 'Shorts',
        category: 'bottoms',
      });
      const sandals = await createGarment(t, {
        name: 'Sandals',
        category: 'footwear',
      });
      const id = await createOutfit({ name: 'Beach' }, [
        ['tops', top],
        ['bottoms', shorts],
      ]);

      const res = await updateOutfit(id, { name: 'Boardwalk', notes: 'Hot' }, [
        ['footwear', sandals],
        ['tops', top],
      ]);
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(`/outfits/${id}`);

      const outfit = await outfitRow(id);
      expect(outfit.name).toBe('Boardwalk');
      expect(outfit.notes).toBe('Hot');
      expect(await savedSlots(id)).toEqual([
        { category: 'footwear', garmentId: sandals },
        { category: 'tops', garmentId: top },
      ]);
      expect(await calendarEntries(id)).toHaveLength(0);

      const form = await t.inject({
        method: 'GET',
        url: `/outfits/${id}/edit`,
      });
      expect(formRows(form.body)).toEqual([
        ['footwear', sandals],
        ['tops', top],
      ]);
    });

    it('removing every row empties the outfit', async () => {
      const top = await createGarment(t, { name: 'Vest', category: 'tops' });
      const id = await createOutfit({ name: 'Emptied' }, [['tops', top]]);

      expect((await updateOutfit(id, { name: 'Emptied' }, [])).statusCode).toBe(
        302,
      );
      expect(await savedSlots(id)).toEqual([]);
    });

    it('leaves name and notes alone when the post does not carry them', async () => {
      const id = await createOutfit({ name: 'Kept', notes: 'As is' }, []);
      const res = await t.inject({
        method: 'POST',
        url: `/outfits/${id}`,
        payload: { category: 'tops', garmentId: '' },
      });
      expect(res.statusCode).toBe(302);
      expect(await outfitRow(id)).toMatchObject({
        name: 'Kept',
        notes: 'As is',
      });
      expect(await savedSlots(id)).toEqual([
        { category: 'tops', garmentId: null },
      ]);
    });

    it('400s a malformed schedule date and changes nothing', async () => {
      const top = await createGarment(t, { name: 'Steady', category: 'tops' });
      const id = await createOutfit({ name: 'Steady' }, [['tops', top]]);
      const res = await updateOutfit(
        id,
        { name: 'Changed', scheduleDate: '2026-13-01' },
        [],
      );
      expect(res.statusCode).toBe(400);
      expect((await outfitRow(id)).name).toBe('Steady');
      expect(await savedSlots(id)).toEqual([
        { category: 'tops', garmentId: top },
      ]);
    });

    it('schedules from the edit form and returns to the calendar week', async () => {
      const id = await createOutfit({ name: 'Rescheduled' }, []);
      const res = await updateOutfit(
        id,
        {
          name: 'Rescheduled',
          scheduleDate: '2026-10-21',
          returnTo: '/calendar',
          returnToWeek: '2026-10-18',
        },
        [],
      );
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/calendar?week=2026-10-18');
      const entries = await calendarEntries(id);
      expect(entries.map((e) => e.day)).toEqual(['2026-10-21']);
    });

    it('saving the same schedule date twice keeps one calendar entry', async () => {
      const id = await createOutfit({ name: 'Saved twice' }, []);
      for (let i = 0; i < 2; i++) {
        const res = await updateOutfit(
          id,
          { name: 'Saved twice', scheduleDate: '2026-10-22' },
          [],
        );
        expect(res.statusCode).toBe(302);
      }
      expect(await calendarEntries(id)).toHaveLength(1);
    });

    it('an edit round trip keeps an archived garment in the outfit', async () => {
      const coat = await createGarment(t, {
        name: 'Archived coat',
        category: 'coats',
      });
      const top = await createGarment(t, {
        name: 'Kept top',
        category: 'tops',
      });
      const id = await createOutfit({ name: 'Winter' }, [
        ['coats', coat],
        ['tops', top],
      ]);
      const archive = await t.inject({
        method: 'POST',
        url: `/wardrobe/${coat}/archive`,
      });
      expect(archive.statusCode).toBeLessThan(300);
      const [archived] = await t.db
        .select({ archived: garmentTable.archived })
        .from(garmentTable)
        .where(eq(garmentTable.id, coat));
      expect(archived.archived).toBe(true);

      // What the browser does: load the form, change the name, submit it.
      const form = await t.inject({
        method: 'GET',
        url: `/outfits/${id}/edit`,
      });
      // The archived garment is shown, and marked.
      expect(form.body).toContain('data-garment-name="Archived coat"');
      expect(hasText(form.body, 'Archived</span>')).toBe(true);
      const res = await updateOutfit(
        id,
        { name: 'Winter (renamed)' },
        formRows(form.body),
      );
      expect(res.statusCode).toBe(302);

      expect(await slotGarmentIds(id)).toEqual(ascending([coat, top]));
      expect(await savedSlots(id)).toEqual([
        { category: 'coats', garmentId: coat },
        { category: 'tops', garmentId: top },
      ]);
    });

    // An archived garment is not in its category's cycle: its row steps to
    // the neighbours it would have by age, and never back to it.
    it('prev/next from an archived garment go to its unarchived neighbours', async () => {
      const [older, archivedOne, newer] = [
        await createGarment(t, { name: 'Belt 1', category: 'belts' }),
        await createGarment(t, { name: 'Belt 2', category: 'belts' }),
        await createGarment(t, { name: 'Belt 3', category: 'belts' }),
      ];
      const id = await createOutfit({ name: 'Belted' }, [
        ['belts', archivedOne],
      ]);
      await t.inject({
        method: 'POST',
        url: `/wardrobe/${archivedOne}/archive`,
      });

      const form = await t.inject({
        method: 'GET',
        url: `/outfits/${id}/edit`,
      });
      const row = unescapeHtml(form.body);
      expect(formRows(row)).toEqual([['belts', archivedOne]]);
      expect(row).toContain('data-count="2"');
      expect(row).not.toContain('data-index=');
      const links = [...row.matchAll(/hx-get="([^"]*)"/g)].map((m) => m[1]);
      expect(links).toEqual([
        '/outfits/row-fragment?category=belts&index=1',
        '/outfits/row-fragment?category=belts&index=2',
      ]);
      const next = await t.inject({ method: 'GET', url: links[1] });
      expect(formRows(next.body)).toEqual([['belts', older]]);
      const prev = await t.inject({ method: 'GET', url: links[0] });
      expect(formRows(prev.body)).toEqual([['belts', newer]]);
    });

    it('404s an update to an unknown outfit', async () => {
      const res = await updateOutfit(999_999, { name: 'Ghost' }, []);
      expect(res.statusCode).toBe(404);
    });
  });

  describe('DELETE /outfits/:id', () => {
    it('removes the outfit, its slots and its calendar entries, but not the garments', async () => {
      const top = await createGarment(t, {
        name: 'Doomed top',
        category: 'tops',
      });
      const id = await createOutfit(
        { name: 'Doomed', scheduleDate: '2026-10-28' },
        [['tops', top]],
      );
      expect(await slotGarmentIds(id)).toEqual([top]);
      expect(await calendarEntries(id)).toHaveLength(1);

      const res = await t.inject({ method: 'DELETE', url: `/outfits/${id}` });
      expect(res.statusCode).toBe(200);
      expect(res.headers['hx-redirect']).toBe('/outfits');

      expect(await outfitRow(id)).toBeUndefined();
      expect(await savedSlots(id)).toEqual([]);
      expect(await calendarEntries(id)).toHaveLength(0);
      const [kept] = await t.db
        .select({ n: count() })
        .from(garmentTable)
        .where(eq(garmentTable.id, top));
      expect(kept.n).toBe(1);

      const gone = await t.inject({ method: 'GET', url: `/outfits/${id}` });
      expect(gone.statusCode).toBe(404);
      const again = await t.inject({ method: 'DELETE', url: `/outfits/${id}` });
      expect(again.statusCode).toBe(404);
    });
  });
});
