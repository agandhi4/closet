import { OutfitCalendar } from '../../src/dal/entity/outfit-calendar.entity';
import { OutfitGarment } from '../../src/dal/entity/outfit-garment.entity';
import { Garment } from '../../src/dal/entity/garment.entity';
import { Outfit, OutfitSlot } from '../../src/dal/entity/outfit.entity';
import { createGarment, jpegPhoto, uploadPhoto } from './garments';
import { createTestApp, hasText, imgTags, TestApp } from './harness';

/**
 * Outfits end to end: the list, the builder and its prev/next row fragment,
 * create/edit/delete as the builder form posts them (urlencoded, one
 * category + garmentId pair per row), and scheduling from the form. Proves
 * the rendered HTML, the `outfit.slots` JSON and the `outfit_garments`
 * pivot rows agree with what the user built.
 */

/** One builder row as the form posts it: category plus garment (or none). */
type Slot = [category: string, garmentId: number | null];

interface OutfitFields {
  name?: string;
  notes?: string;
  scheduleDate?: string;
  returnTo?: string;
  returnToWeek?: string;
}

/** The body views/outfits/form.hbs submits, in document order. */
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

describe('outfits (AUTH_ENABLED=false)', () => {
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

  const pivotGarmentIds = async (outfitId: number): Promise<number[]> =>
    (await t.em().find(OutfitGarment, { outfit: outfitId }))
      .map((row) => row.garment.id)
      .sort(byId);

  const savedSlots = async (outfitId: number): Promise<OutfitSlot[]> =>
    (await t.em().findOneOrFail(Outfit, outfitId)).slots ?? [];

  const calendarEntries = (outfitId: number) =>
    t.em().find(OutfitCalendar, { outfit: outfitId }, { orderBy: { id: 1 } });

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
        '<input type="hidden" name="returnTo" value="/calendar" />',
      );
    });
  });

  describe('GET /outfits/row-fragment (prev/next swap)', () => {
    // garmentService.findAll is newest first, so index 1 is the newest.
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
      /** The prev and next buttons' swap URLs. */
      links: [...html.matchAll(/hx-get="([^"]*)"/g)].map((m) => m[1]),
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
    it('stores the slots as posted and one pivot row per chosen garment', async () => {
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

      const outfit = await t.em().findOneOrFail(Outfit, id);
      expect(outfit.name).toBe('Brunch');
      expect(outfit.notes).toBe('Sunny');
      expect(outfit.owner).toBeFalsy();
      expect(outfit.shareableId).toMatch(/^[0-9a-f-]{36}$/);
      expect(outfit.slots).toEqual([
        { category: 'tops', garmentId: top },
        { category: 'footwear', garmentId: null },
        { category: 'bottoms', garmentId: pants },
      ]);
      expect(await pivotGarmentIds(id)).toEqual(ascending([top, pants]));
      expect(await calendarEntries(id)).toHaveLength(0);
    });

    it('does not attach garment ids that are not in the wardrobe', async () => {
      const top = await createGarment(t, { name: 'Polo', category: 'tops' });
      const id = await createOutfit({ name: 'Tampered' }, [
        ['tops', top],
        ['bottoms', 999_999],
      ]);
      expect(await pivotGarmentIds(id)).toEqual([top]);
    });

    it('accepts a single row (scalar fields, not arrays) and an empty outfit', async () => {
      const top = await createGarment(t, { name: 'Tee', category: 'tops' });
      const single = await createOutfit({ name: 'Single' }, [['tops', top]]);
      expect(await savedSlots(single)).toEqual([
        { category: 'tops', garmentId: top },
      ]);
      expect(await pivotGarmentIds(single)).toEqual([top]);

      const empty = await createOutfit({}, []);
      expect(await savedSlots(empty)).toEqual([]);
      expect(await pivotGarmentIds(empty)).toEqual([]);
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

      const outfit = await t.em().findOneOrFail(Outfit, { name: 'Planned' });
      const entries = await calendarEntries(outfit.id);
      expect(entries).toHaveLength(1);
      expect(entries[0].date.toISOString()).toBe('2026-10-14T00:00:00.000Z');
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

    // Known bug (docs/audits/2026-09-25-program2): saving an outfit and scheduling it are not one transaction.
    it.failing(
      'rejects an invalid schedule date without saving a half-written outfit',
      async () => {
        const before = await t.em().count(Outfit);
        const res = await t.inject({
          method: 'POST',
          url: '/outfits',
          ...outfitForm({ name: 'Bad date', scheduleDate: 'garbage' }, []),
        });
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        expect(res.statusCode).toBeLessThan(500);
        expect(await t.em().count(Outfit)).toBe(before);
      },
    );
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
          `<input type="hidden" name="outfitId" value="${id}" />`,
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

      // Known bug (docs/audits/2026-09-25-program2): the show page renders the unordered outfit_garments pivot, not the saved slot order.
      it.failing(
        'the show page renders garments in the saved order',
        async () => {
          const res = await t.inject({
            method: 'GET',
            url: `/outfits/${outfitId}`,
          });
          expect(shownGarmentIds(res.body)).toEqual(saved);
        },
      );

      // Known bug (docs/audits/2026-09-25-program2): the list renders the unordered outfit_garments pivot, not the saved slot order.
      it.failing('the list renders garments in the saved order', async () => {
        const res = await t.inject({ method: 'GET', url: '/outfits' });
        const start = res.body.indexOf(
          `window.location = '/outfits/${outfitId}'`,
        );
        const end = res.body.indexOf("window.location = '/outfits/", start + 1);
        const card = res.body.slice(start, end === -1 ? undefined : end);
        const alts = imgTags(card).map((tag) => /alt="([^"]*)"/.exec(tag)?.[1]);
        expect(alts).toEqual(['Order shoes', 'Order pants', 'Order top']);
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
        `<input type="hidden" name="returnTo" value="/outfits/${id}" />`,
      );
    });

    it('carries the calendar return target through the edit form', async () => {
      const id = await createOutfit({ name: 'From calendar' }, []);
      const res = await t.inject({
        method: 'GET',
        url: `/outfits/${id}/edit?returnTo=/calendar&returnToWeek=2026-10-11`,
      });
      expect(res.body).toContain(
        '<input type="hidden" name="returnTo" value="/calendar" />',
      );
      expect(res.body).toContain(
        '<input type="hidden" name="returnToWeek" value="2026-10-11" />',
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

      const outfit = await t.em().findOneOrFail(Outfit, id);
      expect(outfit.name).toBe('Boardwalk');
      expect(outfit.notes).toBe('Hot');
      expect(outfit.slots).toEqual([
        { category: 'footwear', garmentId: sandals },
        { category: 'tops', garmentId: top },
      ]);
      expect(await pivotGarmentIds(id)).toEqual(ascending([top, sandals]));
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
      expect(await pivotGarmentIds(id)).toEqual([]);
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
      expect(entries.map((e) => e.date.toISOString())).toEqual([
        '2026-10-21T00:00:00.000Z',
      ]);
    });

    // Known bug (docs/audits/2026-09-25-program2): repeated saves with a schedule date create duplicate calendar entries.
    it.failing(
      'saving the same schedule date twice keeps one calendar entry',
      async () => {
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
      },
    );

    // Known bug (docs/audits/2026-09-25-program2): editing an outfit silently drops archived garments from it.
    it.failing(
      'an edit round trip keeps an archived garment in the outfit',
      async () => {
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
        expect((await t.em().findOneOrFail(Garment, coat)).archived).toBe(true);

        // What the browser does: load the form, change the name, submit it.
        const form = await t.inject({
          method: 'GET',
          url: `/outfits/${id}/edit`,
        });
        const res = await updateOutfit(
          id,
          { name: 'Winter (renamed)' },
          formRows(form.body),
        );
        expect(res.statusCode).toBe(302);

        expect(await pivotGarmentIds(id)).toEqual(ascending([coat, top]));
        expect(await savedSlots(id)).toEqual([
          { category: 'coats', garmentId: coat },
          { category: 'tops', garmentId: top },
        ]);
      },
    );

    it('404s an update to an unknown outfit', async () => {
      const res = await updateOutfit(999_999, { name: 'Ghost' }, []);
      expect(res.statusCode).toBe(404);
    });
  });

  describe('DELETE /outfits/:id', () => {
    it('removes the outfit, its pivot rows and its calendar entries, but not the garments', async () => {
      const top = await createGarment(t, {
        name: 'Doomed top',
        category: 'tops',
      });
      const id = await createOutfit(
        { name: 'Doomed', scheduleDate: '2026-10-28' },
        [['tops', top]],
      );
      expect(await pivotGarmentIds(id)).toEqual([top]);
      expect(await calendarEntries(id)).toHaveLength(1);

      const res = await t.inject({ method: 'DELETE', url: `/outfits/${id}` });
      expect(res.statusCode).toBe(200);
      expect(res.headers['hx-redirect']).toBe('/outfits');

      expect(await t.em().findOne(Outfit, id)).toBeNull();
      expect(await pivotGarmentIds(id)).toEqual([]);
      expect(await calendarEntries(id)).toHaveLength(0);
      expect(await t.em().findOne(Garment, top)).not.toBeNull();

      const gone = await t.inject({ method: 'GET', url: `/outfits/${id}` });
      expect(gone.statusCode).toBe(404);
      const again = await t.inject({ method: 'DELETE', url: `/outfits/${id}` });
      expect(again.statusCode).toBe(404);
    });
  });
});
