import { and, count, eq, isNotNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  garmentWear,
  outfitCalendar,
  trip,
  tripGarmentPacked,
  tripItem,
  tripOutfit,
} from '../../src/db/schema';
import { addDays } from '../../src/web/calendar/calendar-date';
import { startWeatherStub, type WeatherStub } from '../support/weather-stub';
import {
  createTestApp,
  hasText,
  hxLocationPath,
  type TestApp,
  unescapeHtml,
} from './harness';
import { callTool, createAccessToken, tool } from './mcp';
import { expectFragment, expectFullPage, HX_FRAGMENT } from './pages';

/**
 * Trips and packing lists (#10): the trip form, outfits for its days and
 * occasions (from the saved list and from the gallery with `for=trip:ID`),
 * the derived packing list (copies needed, warnings; the rule itself is
 * unit-tested in src/wardrobe/packing.spec.ts), packed marks that survive
 * edits and leave with their garments, extras and their copy from another
 * trip, "Wearing this today" through the calendar, the destination's
 * forecast, and the MCP tools.
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

describe('trips', () => {
  let t: TestApp;
  let stub: WeatherStub;
  let token: string;
  // The owner's closet: 3 white tees, jeans, sneakers, a jacket, 6 socks.
  let tee: number;
  let jeans: number;
  let sneakers: number;
  let jacket: number;
  let socks: number;
  let polo: number;
  let dayOutfit: number;
  let dinnerOutfit: number;
  let poloOutfit: number;

  const post = (url: string, fields: Fields, headers = {}) => {
    const body = form(fields);
    return t.inject({
      method: 'POST',
      url,
      payload: body.payload,
      headers: { ...body.headers, ...headers },
    });
  };
  const get = (url: string) => t.inject({ method: 'GET', url });

  const garment = async (fields: Fields): Promise<number> => {
    const res = await post('/wardrobe', { props: '1', care: '1', ...fields });
    expect(res.statusCode).toBe(302);
    return Number(
      /^\/wardrobe\/(\d+)\?/.exec(String(res.headers.location))![1],
    );
  };

  const outfitOf = async (
    name: string,
    garments: [category: string, id: number][],
  ): Promise<number> => {
    const res = await post('/outfits', {
      name,
      category: garments.map(([category]) => category),
      garmentId: garments.map(([, id]) => String(id)),
    });
    expect(res.statusCode).toBe(302);
    return Number(/^\/outfits\/(\d+)$/.exec(String(res.headers.location))![1]);
  };

  const newTrip = async (fields: Partial<Record<string, string>> = {}) => {
    const today = t.today();
    const res = await post('/trips', {
      name: 'Austin conference',
      destination: '',
      startsOn: addDays(today, 3),
      endsOn: addDays(today, 7),
      notes: '',
      ...fields,
    });
    expect(res.statusCode, res.body).toBe(303);
    const location = String(res.headers.location);
    expect(location).toMatch(/^\/trips\/\d+\?created=1$/);
    return Number(/^\/trips\/(\d+)/.exec(location)![1]);
  };

  const addOutfit = (
    tripId: number,
    outfitId: number,
    slot: { day?: string; occasion?: string } = {},
  ) =>
    post(`/trips/${tripId}/outfits`, {
      outfitId: String(outfitId),
      day: slot.day ?? '',
      occasion: slot.occasion ?? '',
    });

  const packedOf = async (tripId: number) =>
    (
      await t.db
        .select({ id: tripGarmentPacked.garmentId })
        .from(tripGarmentPacked)
        .where(eq(tripGarmentPacked.tripId, tripId))
    )
      .map((row) => row.id)
      .sort((a, b) => a - b);

  const pack = (
    tripId: number,
    packed: number[],
    shown: number[],
    headers = {},
  ) =>
    post(
      `/trips/${tripId}/packed`,
      { packed: packed.map(String), shown: shown.map(String) },
      headers,
    );

  /** A garment's row on the trip page: its pack count and warnings. */
  const packingRow = (html: string, garmentId: number): string => {
    const start = html.indexOf(`data-packing-garment="${garmentId}"`);
    expect(start, `garment ${garmentId} on the list`).toBeGreaterThan(-1);
    const ends = [
      html.indexOf('data-packing-garment=', start + 1),
      html.indexOf('</fieldset>', start),
    ].filter((end) => end > -1);
    return html.slice(start, Math.min(...ends));
  };

  beforeAll(async () => {
    stub = await startWeatherStub();
    t = await createTestApp(
      { WEATHER_ENABLED: 'true' },
      { weather: stub.options },
    );
    tee = await garment({
      name: 'White tee',
      category: 'tops',
      color: ['white'],
      quantity: '3',
    });
    jeans = await garment({
      name: 'Raw jeans',
      category: 'bottoms',
      color: ['blue'],
    });
    sneakers = await garment({
      name: 'White sneakers',
      category: 'footwear',
      color: ['white'],
    });
    jacket = await garment({
      name: 'Denim jacket',
      category: 'outerwear',
      color: ['blue'],
    });
    socks = await garment({
      name: 'Socks',
      category: 'accessories',
      color: ['white'],
      quantity: '6',
      washAfterWears: '1',
    });
    polo = await garment({
      name: 'Navy polo',
      category: 'tops',
      color: ['blue'],
    });
    dayOutfit = await outfitOf('Conference day', [
      ['tops', tee],
      ['bottoms', jeans],
      ['footwear', sneakers],
      ['accessories', socks],
    ]);
    dinnerOutfit = await outfitOf('Dinner', [
      ['outerwear', jacket],
      ['tops', tee],
      ['bottoms', jeans],
      ['footwear', sneakers],
    ]);
    poloOutfit = await outfitOf('Polo day', [
      ['tops', polo],
      ['bottoms', jeans],
    ]);
    token = await createAccessToken(t);
  });

  afterAll(async () => {
    await t?.cleanup();
    await stub?.close();
  });

  describe('the trip form', () => {
    it('creates a trip and lists it under the Calendar’s Trips tab', async () => {
      const id = await newTrip({ name: '  Lisbon  ', destination: ' Lisbon ' });
      const [row] = await t.db.select().from(trip).where(eq(trip.id, id));
      expect(row).toMatchObject({
        name: 'Lisbon',
        destination: 'Lisbon',
        latitude: null,
        ownerId: t.owner.id,
      });
      const list = await get('/trips');
      expect(list.statusCode).toBe(200);
      expectFullPage(list);
      expect(list.body).toContain(`href="/trips/${id}"`);
      expect(await addOutfit(id, dayOutfit)).toMatchObject({ statusCode: 303 });
      await post(`/trips/${id}/items`, { label: 'Adapter' });
      await post(`/trips/${id}/items`, { label: 'Charger' });
      const counted = unescapeHtml((await get('/trips')).body);
      const card = counted.slice(counted.indexOf(`data-trip="${id}"`));
      expect(card.slice(0, card.indexOf('</a>'))).toContain(
        'Outfits: 1 · Extras: 2',
      );
      // The Calendar's tabs, Trips current; the dock marks the Calendar.
      expect(list.body).toMatch(/href="\/trips"[^>]*class="tab tab-active"/);
      expect(list.body).toMatch(/href="\/calendar"[^>]*class="tab"/);
      const page = await get(`/trips/${id}?created=1`);
      expect(page.statusCode).toBe(200);
      expectFullPage(page);
      expect(page.body).toContain('Trip created');
      // One section per day, then "Any day".
      expect(
        page.body.match(/data-trip-day="\d{4}-\d{2}-\d{2}"/g),
      ).toHaveLength(5);
      expect(page.body).toContain('data-trip-day="any"');
    });

    it('refuses a blank name, a backward range or a trip past 60 days, with messages', async () => {
      const today = t.today();
      const before = await t.db.$count(trip);
      const valid = {
        name: 'Refused',
        startsOn: today,
        endsOn: addDays(today, 2),
      };
      const cases: [Fields, string][] = [
        [{ ...valid, name: '  ' }, 'Give the trip a name'],
        [
          { ...valid, startsOn: addDays(today, 5), endsOn: addDays(today, 4) },
          'The last day comes before the first',
        ],
        [{ ...valid, endsOn: addDays(today, 60) }, 'A trip is at most 60 days'],
        [{ ...valid, startsOn: '' }, 'Choose a day'],
      ];
      for (const [fields, message] of cases) {
        const res = await post('/trips', fields);
        expect(res.statusCode).toBe(400);
        expectFullPage(res);
        expect(res.body).toContain(message);
      }
      expect(await t.db.$count(trip)).toBe(before);
    });

    it('moves outfits of days a new date range leaves out to any day, once each', async () => {
      const id = await newTrip();
      const first = addDays(t.today(), 3);
      const last = addDays(t.today(), 7);
      expect((await addOutfit(id, dayOutfit, { day: first })).statusCode).toBe(
        303,
      );
      expect((await addOutfit(id, dayOutfit, { day: last })).statusCode).toBe(
        303,
      );
      expect(
        (await addOutfit(id, poloOutfit, { day: last, occasion: 'evening' }))
          .statusCode,
      ).toBe(303);
      const res = await post(`/trips/${id}`, {
        name: 'Shorter',
        startsOn: addDays(first, 1),
        endsOn: addDays(last, -1),
      });
      expect(res.statusCode).toBe(303);
      const rows = await t.db
        .select({
          outfitId: tripOutfit.outfitId,
          day: tripOutfit.day,
          occasion: tripOutfit.occasion,
        })
        .from(tripOutfit)
        .where(eq(tripOutfit.tripId, id));
      // The day outfit was on two dropped days: one undated row, not two.
      expect(rows.sort((a, b) => a.outfitId - b.outfitId)).toEqual([
        { outfitId: dayOutfit, day: null, occasion: null },
        { outfitId: poloOutfit, day: null, occasion: 'evening' },
      ]);
    });
  });

  describe('outfits on a trip', () => {
    let id: number;
    let days: string[];

    beforeAll(async () => {
      id = await newTrip();
      days = [0, 1, 2, 3, 4].map((n) => addDays(t.today(), 3 + n));
    });

    it('adds a saved outfit for a day and an occasion, once', async () => {
      const res = await addOutfit(id, dayOutfit, {
        day: days[0],
        occasion: 'daytime',
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(`/trips/${id}#day-${days[0]}`);
      // Again, even for another occasion: nothing more, the first occasion kept.
      expect(
        (await addOutfit(id, dayOutfit, { day: days[0], occasion: 'evening' }))
          .statusCode,
      ).toBe(303);
      const rows = await t.db
        .select({ day: tripOutfit.day, occasion: tripOutfit.occasion })
        .from(tripOutfit)
        .where(
          and(eq(tripOutfit.tripId, id), eq(tripOutfit.outfitId, dayOutfit)),
        );
      expect(rows).toEqual([{ day: days[0], occasion: 'daytime' }]);
      expect(t.logs.messages('info', 'Web').at(-1)).toMatch(/already on trip/);
    });

    it('refuses a day outside the trip (400) and someone else’s outfit (404)', async () => {
      expect(
        (await addOutfit(id, dayOutfit, { day: addDays(days[4], 1) }))
          .statusCode,
      ).toBe(400);
      const cookie = await t.register('other-trips@example.com');
      const theirs = await t.inject({
        method: 'POST',
        url: '/outfits',
        ...form({ name: 'Theirs', category: 'tops', garmentId: '' }),
        headers: { ...form({}).headers, cookie },
      });
      const theirOutfit = Number(
        /^\/outfits\/(\d+)$/.exec(String(theirs.headers.location))![1],
      );
      expect((await addOutfit(id, theirOutfit)).statusCode).toBe(404);
    });

    it('offers the saved outfits on the add page, those on the day disabled', async () => {
      const res = await get(
        `/trips/${id}/outfits/new?day=${days[0]}&occasion=evening`,
      );
      expect(res.statusCode).toBe(200);
      expectFullPage(res);
      const html = unescapeHtml(res.body);
      expect(html).toMatch(new RegExp(`value="${dayOutfit}"[^>]*disabled=""`));
      expect(html).not.toMatch(
        new RegExp(`value="${poloOutfit}"[^>]*disabled=""`),
      );
      expect(html).toContain(`name="day" value="${days[0]}"`);
      expect(html).toContain('name="occasion" value="evening"');
      // Ideas for the same day and occasion, through the gallery.
      expect(html).toContain(
        `/outfits/ideas?for=trip:${id}:${days[0]}&occasion=evening`,
      );
      // A day that is not the trip's is no day (navigation state).
      const lenient = await get(
        `/trips/${id}/outfits/new?day=1999-01-01&occasion=brunch`,
      );
      expect(lenient.statusCode).toBe(200);
      expect(unescapeHtml(lenient.body)).toContain('name="day" value=""');
    });
  });

  describe('the packing list', () => {
    let id: number;
    let days: string[];

    beforeAll(async () => {
      id = await newTrip();
      days = [0, 1, 2, 3, 4].map((n) => addDays(t.today(), 3 + n));
      // The day outfit every day, dinner on the first two: tees and jeans
      // worn once a day whatever the occasions.
      for (const day of days) {
        expect(
          (await addOutfit(id, dayOutfit, { day, occasion: 'daytime' }))
            .statusCode,
        ).toBe(303);
      }
      for (const day of days.slice(0, 2)) {
        expect(
          (await addOutfit(id, dinnerOutfit, { day, occasion: 'evening' }))
            .statusCode,
        ).toBe(303);
      }
    });

    it('lists each garment once, by role, with the copies to pack and why not', async () => {
      const res = await get(`/trips/${id}`);
      expect(res.statusCode).toBe(200);
      const html = unescapeHtml(res.body);
      const roles = [...html.matchAll(/<fieldset data-role="([a-z-]+)"/g)].map(
        (m) => m[1],
      );
      expect(roles).toEqual([
        'layer',
        'top',
        'bottom',
        'footwear',
        'accessory',
      ]);
      // Tees (k = 1): 5 days, 3 owned: pack 3, 2 short.
      expect(packingRow(html, tee)).toContain('data-pack="3"');
      expect(packingRow(html, tee)).toContain('You own 3, the trip needs 5');
      expect(packingRow(html, tee)).toContain('In 7 outfits');
      // Jeans (k = 3): 5 days, 2 copies needed, 1 owned.
      expect(packingRow(html, jeans)).toContain('You own 1, the trip needs 2');
      // Socks (k = 1), 6 owned: 5 to pack, nothing to say.
      expect(packingRow(html, socks)).toContain('data-pack="5"');
      expect(packingRow(html, socks)).not.toContain('data-warning');
      // Sneakers are never washed: one pair.
      expect(packingRow(html, sneakers)).not.toContain('data-pack="');
      // Pieces: 1 jacket, 3 tees, 1 pair of jeans, 1 of sneakers, 5 socks.
      expect(html).toMatch(/0 of 5 packed · 11 pieces/);
    });

    it('warns to wash a garment with too few clean copies, and one lent out', async () => {
      // A tee worn today: 2 of 3 clean, 3 to pack. Six socks worn once:
      // 5 clean, 5 to pack, nothing to say. The jacket lent.
      for (const id of [tee, socks]) {
        expect(
          (await post(`/wardrobe/${id}/wear`, { worn: '1' })).statusCode,
        ).toBe(303);
      }
      expect(
        (await post(`/wardrobe/${jacket}/away`, { away: 'lent', awayNote: '' }))
          .statusCode,
      ).toBe(303);
      const html = unescapeHtml((await get(`/trips/${id}`)).body);
      expect(packingRow(html, tee)).toContain('Wash before you pack: 2 clean');
      expect(packingRow(html, socks)).not.toContain('data-warning');
      expect(packingRow(html, jacket)).toContain('Lent out');
      expect(html).toContain('need attention');
      // Unworn and back: the warnings go.
      for (const id of [tee, socks]) {
        expect(
          (await post(`/wardrobe/${id}/wear`, { worn: '0' })).statusCode,
        ).toBe(303);
      }
      expect(
        (await post(`/wardrobe/${jacket}/away`, { away: '', awayNote: '' }))
          .statusCode,
      ).toBe(303);
      const after = unescapeHtml((await get(`/trips/${id}`)).body);
      expect(packingRow(after, tee)).not.toContain('data-warning="wash"');
      expect(packingRow(after, jacket)).not.toContain('data-warning');
    });

    it('saves packed marks on change, answering the status line and the summary', async () => {
      const res = await pack(
        id,
        [tee, jeans],
        [tee, jeans, sneakers],
        HX_FRAGMENT,
      );
      expect(res.statusCode).toBe(200);
      expectFragment(res);
      expect(res.body).toContain('Saved');
      expect(res.body).toMatch(
        /id="trip-packed-summary"[^>]*hx-swap-oob="true"/,
      );
      expect(res.body).toContain('2 of 5 packed');
      expect(await packedOf(id)).toEqual([tee, jeans].sort((a, b) => a - b));
      // Unchecked among those shown leaves; what was not shown stays.
      await pack(id, [sneakers], [jeans, sneakers]);
      expect(await packedOf(id)).toEqual([tee, sneakers].sort((a, b) => a - b));
      // A garment of no outfit on the trip is never marked.
      await pack(id, [polo], [polo]);
      expect(await packedOf(id)).not.toContain(polo);
      // The page shows them checked.
      const html = unescapeHtml((await get(`/trips/${id}`)).body);
      expect(packingRow(html, tee)).toMatch(
        /name="packed" value="\d+"[^>]*checked/,
      );
      expect(packingRow(html, jeans)).not.toMatch(/name="packed"[^>]*checked/);
    });

    it('keeps packed marks through edits that keep the garment on the list', async () => {
      await pack(id, [tee, jeans, jacket], [tee, jeans, jacket, sneakers]);
      const marked = await packedOf(id);
      // The trip renamed, an outfit added, the dinner outfit re-saved whole.
      expect(
        (
          await post(`/trips/${id}`, {
            name: 'Renamed',
            startsOn: days[0],
            endsOn: days[4],
          })
        ).statusCode,
      ).toBe(303);
      expect(
        (await addOutfit(id, poloOutfit, { day: days[2] })).statusCode,
      ).toBe(303);
      const saved = await post(`/outfits/${dinnerOutfit}`, {
        name: 'Dinner',
        category: ['outerwear', 'tops', 'bottoms', 'footwear'],
        garmentId: [jacket, tee, jeans, sneakers].map(String),
      });
      expect(saved.statusCode).toBe(302);
      expect(await packedOf(id)).toEqual(marked);
    });

    it('removes the marks of garments that leave the list, with them', async () => {
      await pack(id, [tee, jeans, jacket, polo], [tee, jeans, jacket, polo]);
      expect(await packedOf(id)).toContain(polo);
      // Taking the polo outfit off: the polo leaves; the jeans stay (others hold them).
      const [poloRow] = await t.db
        .select({ id: tripOutfit.id })
        .from(tripOutfit)
        .where(
          and(eq(tripOutfit.tripId, id), eq(tripOutfit.outfitId, poloOutfit)),
        );
      const removed = await post(
        `/trips/${id}/outfits/${poloRow.id}/delete`,
        {},
      );
      expect(removed.statusCode).toBe(303);
      expect(await packedOf(id)).toEqual(
        [tee, jeans, jacket].sort((a, b) => a - b),
      );
      // The jacket edited out of the dinner outfit: its mark goes with it.
      const edited = await post(`/outfits/${dinnerOutfit}`, {
        name: 'Dinner',
        category: ['tops', 'bottoms', 'footwear'],
        garmentId: [tee, jeans, sneakers].map(String),
      });
      expect(edited.statusCode).toBe(302);
      expect(await packedOf(id)).toEqual([tee, jeans].sort((a, b) => a - b));
      // Put back: it comes back unpacked.
      await post(`/outfits/${dinnerOutfit}`, {
        name: 'Dinner',
        category: ['outerwear', 'tops', 'bottoms', 'footwear'],
        garmentId: [jacket, tee, jeans, sneakers].map(String),
      });
      expect(await packedOf(id)).not.toContain(jacket);
    });

    it('removes the marks of an outfit’s garments when the outfit is deleted', async () => {
      const lonely = await outfitOf('Polo only', [['tops', polo]]);
      expect((await addOutfit(id, lonely)).statusCode).toBe(303);
      await pack(id, [polo], [polo]);
      expect(await packedOf(id)).toContain(polo);
      const deleted = await t.inject({
        method: 'DELETE',
        url: `/outfits/${lonely}`,
        headers: HX_FRAGMENT,
      });
      expect(deleted.statusCode).toBe(200);
      expect(await packedOf(id)).not.toContain(polo);
      expect(
        await t.db.$count(tripOutfit, eq(tripOutfit.outfitId, lonely)),
      ).toBe(0);
    });
  });

  describe('extras', () => {
    let first: number;
    let second: number;

    beforeAll(async () => {
      first = await newTrip({ name: 'First trip' });
      second = await newTrip({ name: 'Second trip' });
    });

    const labels = async (tripId: number) =>
      (
        await t.db
          .select({ label: tripItem.label, packed: tripItem.packed })
          .from(tripItem)
          .where(eq(tripItem.tripId, tripId))
          .orderBy(tripItem.id)
      ).map((row) => `${row.label}${row.packed ? ' ✓' : ''}`);

    it('adds extras once whatever their case, packs them on change and removes them', async () => {
      for (const label of [
        'Phone charger',
        'Toiletries',
        ' phone CHARGER ',
        'Passport',
      ]) {
        const res = await post(`/trips/${first}/items`, { label });
        expect(res.statusCode).toBe(303);
        expect(res.headers.location).toBe(`/trips/${first}#extras`);
      }
      expect(await labels(first)).toEqual([
        'Phone charger',
        'Toiletries',
        'Passport',
      ]);
      const items = await t.db
        .select({ id: tripItem.id, label: tripItem.label })
        .from(tripItem)
        .where(eq(tripItem.tripId, first))
        .orderBy(tripItem.id);
      const res = await post(
        `/trips/${first}/items/packed`,
        {
          packed: [String(items[0].id)],
          shown: items.map((i) => String(i.id)),
        },
        HX_FRAGMENT,
      );
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('1 of 3 packed');
      expect(await labels(first)).toEqual([
        'Phone charger ✓',
        'Toiletries',
        'Passport',
      ]);
      const removed = await post(
        `/trips/${first}/items/${items[2].id}/delete`,
        {},
      );
      expect(removed.statusCode).toBe(303);
      expect(await labels(first)).toEqual(['Phone charger ✓', 'Toiletries']);
    });

    it('copies extras from a previous trip, unpacked and once', async () => {
      await post(`/trips/${second}/items`, { label: 'Toiletries' });
      const page = unescapeHtml((await get(`/trips/${second}`)).body);
      expect(page).toContain(
        `<option value="${first}">From First trip (2)</option>`,
      );
      const copied = await post(`/trips/${second}/items/copy`, {
        from: String(first),
      });
      expect(copied.statusCode).toBe(303);
      expect(copied.headers.location).toBe(`/trips/${second}?copied=1#extras`);
      expect(await labels(second)).toEqual(['Toiletries', 'Phone charger']);
      await post(`/trips/${second}/items/copy`, { from: String(first) });
      expect(await labels(second)).toEqual(['Toiletries', 'Phone charger']);
      // Not from itself, nor from someone else's trip.
      expect(
        (await post(`/trips/${second}/items/copy`, { from: String(second) }))
          .statusCode,
      ).toBe(404);
    });
  });

  describe('ideas for a trip (the gallery with for=trip:ID)', () => {
    let id: number;
    let day: string;

    beforeAll(async () => {
      id = await newTrip({ name: 'Ideas trip' });
      day = addDays(t.today(), 4);
    });

    it('opens the gallery for the trip’s day, with the trip’s pick', async () => {
      const res = await get(
        `/outfits/ideas?for=trip:${id}:${day}&occasion=evening`,
      );
      expect(res.statusCode).toBe(200);
      expectFullPage(res);
      const html = unescapeHtml(res.body);
      expect(html).toContain(`data-ideas-trip="${id}"`);
      expect(html).toContain('For Ideas trip');
      expect(html).toContain('Add to the trip');
      expect(html).toContain(`name="for" value="trip:${id}:${day}"`);
      expect(html).toContain('name="occasion" value="evening"');
      // Shuffle keeps the destination.
      expect(html).toMatch(
        new RegExp(
          `/outfits/ideas\\?for=trip:${id}:${day}&occasion=evening&seed=\\d+`,
        ),
      );
    });

    it('adds a picked idea to the trip, once, and 404s someone else’s trip', async () => {
      const garments = [tee, jeans, sneakers];
      const pick = () =>
        post('/outfits/ideas/pick', {
          garmentId: garments.map(String),
          for: `trip:${id}:${day}`,
          occasion: 'evening',
          seed: '1',
        });
      const res = await pick();
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(`/trips/${id}?picked=1`);
      await pick();
      const rows = await t.db
        .select({ day: tripOutfit.day, occasion: tripOutfit.occasion })
        .from(tripOutfit)
        .where(eq(tripOutfit.tripId, id));
      expect(rows).toEqual([{ day, occasion: 'evening' }]);
      // No calendar entry: a trip is a list, not the calendar.
      const [outfitRow] = await t.db
        .select({ outfitId: tripOutfit.outfitId })
        .from(tripOutfit)
        .where(eq(tripOutfit.tripId, id));
      expect(
        await t.db.$count(
          outfitCalendar,
          eq(outfitCalendar.outfitId, outfitRow.outfitId),
        ),
      ).toBe(0);
      // A day outside it, or a malformed one, is refused.
      const outside = await post('/outfits/ideas/pick', {
        garmentId: garments.map(String),
        for: `trip:${id}:${addDays(day, 30)}`,
      });
      expect(outside.statusCode).toBe(400);
      const malformed = await post('/outfits/ideas/pick', {
        garmentId: garments.map(String),
        for: `trip:${id}:2026-02-30`,
      });
      expect(malformed.statusCode).toBe(400);
      const stranger = await t.register('trip-stranger@example.com');
      const theirs = await t.inject({
        method: 'GET',
        url: `/outfits/ideas?for=trip:${id}`,
        headers: { cookie: stranger },
      });
      expect(theirs.statusCode).toBe(404);
    });
  });

  describe('"Wearing this today"', () => {
    it('plans the trip outfit today and marks it worn through the calendar, once', async () => {
      const today = t.today();
      const id = await newTrip({
        name: 'On now',
        startsOn: today,
        endsOn: addDays(today, 2),
      });
      expect(
        (await addOutfit(id, poloOutfit, { day: today, occasion: 'work' }))
          .statusCode,
      ).toBe(303);
      const page = unescapeHtml((await get(`/trips/${id}`)).body);
      const [row] = await t.db
        .select({ id: tripOutfit.id })
        .from(tripOutfit)
        .where(eq(tripOutfit.tripId, id));
      expect(page).toContain(`/trips/${id}/outfits/${row.id}/wear`);
      const wearsBefore = await t.db.$count(garmentWear);
      for (let tap = 0; tap < 2; tap += 1) {
        const res = await post(`/trips/${id}/outfits/${row.id}/wear`, {});
        expect(res.statusCode).toBe(303);
      }
      const entries = await t.db
        .select({ occasion: outfitCalendar.occasion })
        .from(outfitCalendar)
        .where(
          and(
            eq(outfitCalendar.outfitId, poloOutfit),
            eq(outfitCalendar.day, today),
            isNotNull(outfitCalendar.wornAt),
          ),
        );
      expect(entries).toEqual([{ occasion: 'work' }]);
      expect(await t.db.$count(garmentWear)).toBe(wearsBefore + 2);
      expect(t.logs.messages('info', 'Web').at(-1)).toMatch(/already worn$/);
      const after = unescapeHtml((await get(`/trips/${id}`)).body);
      expect(after).toContain('Worn today');
    });

    it('is refused (409) while the trip is not on', async () => {
      const id = await newTrip();
      expect((await addOutfit(id, poloOutfit)).statusCode).toBe(303);
      const [row] = await t.db
        .select({ id: tripOutfit.id })
        .from(tripOutfit)
        .where(eq(tripOutfit.tripId, id));
      const res = await post(`/trips/${id}/outfits/${row.id}/wear`, {});
      expect(res.statusCode).toBe(409);
      expect(unescapeHtml((await get(`/trips/${id}`)).body)).not.toContain(
        '/wear"',
      );
    });
  });

  describe('the destination’s forecast', () => {
    it('finds the destination through the weather’s search and shows its days within the forecast', async () => {
      const id = await newTrip({ destination: 'Austin' });
      const before = await get(`/trips/${id}/weather`);
      expectFragment(before);
      expect(before.body).toContain('data-trip-weather="no-location"');
      const search = await t.inject({
        method: 'GET',
        url: `/trips/${id}/places?q=austin`,
        headers: HX_FRAGMENT,
      });
      expect(search.statusCode).toBe(200);
      expect(unescapeHtml(search.body)).toContain(
        'Austin, Texas, United States',
      );
      // The request log names the route, never the typed city.
      expect(JSON.stringify(t.logs.records)).not.toContain('q=austin');
      const set = await post(`/trips/${id}/destination`, {
        name: 'Austin, Texas, United States',
        latitude: '30.26715',
        longitude: '-97.74306',
      });
      expect(set.statusCode).toBe(303);
      const [row] = await t.db.select().from(trip).where(eq(trip.id, id));
      expect(row).toMatchObject({ latitude: 30.27, longitude: -97.74 });
      const res = await get(`/trips/${id}/weather`);
      expectFragment(res);
      const html = unescapeHtml(res.body);
      const shown = [...html.matchAll(/data-weather-day="([\d-]+)"/g)].map(
        (m) => m[1],
      );
      expect(shown).toEqual([3, 4, 5, 6, 7].map((n) => addDays(t.today(), n)));
      expect(html).toContain(`/outfits/ideas?for=trip:${id}:${shown[0]}`);
      expect(
        stub.hits.some((hit) =>
          hit.includes('latitude=30.27&longitude=-97.74'),
        ),
      ).toBe(true);
      // A new destination name clears the location it no longer describes.
      await post(`/trips/${id}`, {
        name: 'Austin conference',
        destination: 'Dallas',
        startsOn: shown[0],
        endsOn: shown[4],
      });
      const [renamed] = await t.db.select().from(trip).where(eq(trip.id, id));
      expect(renamed).toMatchObject({
        destination: 'Dallas',
        latitude: null,
        longitude: null,
      });
      // Someone else's trip is not found, weather routes included.
      const cookie = await t.register('trip-weather-stranger@example.com');
      for (const request of [
        { method: 'GET' as const, url: `/trips/${id}/weather` },
        { method: 'GET' as const, url: `/trips/${id}/places?q=austin` },
        {
          method: 'POST' as const,
          url: `/trips/${id}/destination`,
          ...form({ name: 'Austin', latitude: '30.27', longitude: '-97.74' }),
        },
      ]) {
        const res = await t.inject({
          ...request,
          headers: { ...('headers' in request ? request.headers : {}), cookie },
        });
        expect(res.statusCode, request.url).toBe(404);
      }
      const [kept] = await t.db.select().from(trip).where(eq(trip.id, id));
      expect(kept.latitude).toBeNull();
    });

    it('says from when the forecast of days past 16 days arrives, with their typical weather meanwhile and no forecast fetched', async () => {
      const today = t.today();
      const id = await newTrip({
        startsOn: addDays(today, 30),
        endsOn: addDays(today, 32),
      });
      await post(`/trips/${id}/destination`, {
        name: 'Austin, Texas, United States',
        latitude: '30.27',
        longitude: '-97.74',
      });
      const forecasts = () =>
        stub.hits.filter((hit) => hit.startsWith('/v1/forecast?')).length;
      const before = forecasts();
      const res = await get(`/trips/${id}/weather`);
      expect(res.body).toContain('data-forecast-from=""');
      expect(hasText(res.body, 'arrives on')).toBe(true);
      // The climate normals (climate-normals.spec.ts covers them).
      expect(res.body).toContain('data-trip-typical=""');
      expect(forecasts()).toBe(before);
    });

    it('gives the gallery the destination’s forecast for a trip day', async () => {
      const today = t.today();
      const id = await newTrip({
        startsOn: addDays(today, 1),
        endsOn: addDays(today, 2),
      });
      const ideas = await get(
        `/outfits/ideas?for=trip:${id}:${addDays(today, 1)}`,
      );
      // Not located yet: no weather, rather than home's.
      expect(ideas.body).not.toContain('data-ideas-weather');
      await post(`/trips/${id}/destination`, {
        name: 'Austin, Texas, United States',
        latitude: '30.27',
        longitude: '-97.74',
      });
      const located = await get(
        `/outfits/ideas?for=trip:${id}:${addDays(today, 1)}`,
      );
      expect(located.body).toContain('data-ideas-weather');
    });
  });

  describe('MCP', () => {
    it('lists trips, reads one with its packing list, and plans outfits on it', async () => {
      const today = t.today();
      const id = await newTrip({
        name: 'MCP trip',
        startsOn: addDays(today, 3),
        endsOn: addDays(today, 4),
      });
      const listed = await tool<{ trips: { id: number; phase: string }[] }>(
        t,
        token,
        'list_trips',
      );
      expect(listed.trips.find((row) => row.id === id)).toMatchObject({
        phase: 'upcoming',
      });
      const added = await tool(t, token, 'plan_trip_outfit', {
        tripId: id,
        outfitId: dayOutfit,
        date: addDays(today, 3),
        occasion: 'work',
      });
      expect(added).toMatchObject({ added: true, outfitCreated: false });
      const again = await tool(t, token, 'plan_trip_outfit', {
        tripId: id,
        outfitId: dayOutfit,
        date: addDays(today, 3),
      });
      expect(again).toMatchObject({ added: false });
      const picked = await tool(t, token, 'plan_trip_outfit', {
        tripId: id,
        garmentIds: [polo, sneakers],
        date: addDays(today, 4),
      });
      expect(picked).toMatchObject({ added: true, outfitCreated: true });
      const refused = await callTool(t, token, 'plan_trip_outfit', {
        tripId: id,
        outfitId: dayOutfit,
        date: addDays(today, 9),
      });
      expect(refused.isError).toBe(true);
      expect(refused.value.error).toMatch(/day of the trip/);
      const both = await callTool(t, token, 'plan_trip_outfit', { tripId: id });
      expect(both.value.error).toBe('Give either outfitId or garmentIds');
      const read = await tool<{
        days: { outfits: { outfitId: number; occasion: string | null }[] }[];
        packing: {
          groups: {
            role: string;
            garments: {
              id: number;
              copiesNeeded: number;
              pack: number;
              warnings: { kind: string }[];
            }[];
          }[];
        };
        weather?: unknown;
      }>(t, token, 'get_trip', { tripId: id });
      expect(read.days[0].outfits).toEqual([
        expect.objectContaining({ outfitId: dayOutfit, occasion: 'work' }),
      ]);
      const bottoms = read.packing.groups.find((g) => g.role === 'bottom')!;
      // Jeans on both days: 2 wears, one copy (k = 3).
      expect(bottoms.garments).toEqual([
        expect.objectContaining({ id: jeans, copiesNeeded: 1, pack: 1 }),
      ]);
      expect(read.weather).toEqual({ status: 'no-location' });
      const stranger = await t.register('mcp-trip-stranger@example.com');
      const theirToken = await createAccessToken(t, { cookie: stranger });
      const hidden = await callTool(t, theirToken, 'get_trip', { tripId: id });
      expect(hidden.value.error).toBe('Trip not found');
      const theirAdd = await callTool(t, theirToken, 'plan_trip_outfit', {
        tripId: id,
        outfitId: dayOutfit,
      });
      expect(theirAdd.value.error).toBe('Trip not found');
    });
  });

  it('deletes a trip with its rows, keeping its outfits', async () => {
    const id = await newTrip({ name: 'Doomed' });
    await addOutfit(id, dayOutfit);
    await post(`/trips/${id}/items`, { label: 'Hat' });
    await pack(id, [tee], [tee]);
    const res = await t.inject({
      method: 'DELETE',
      url: `/trips/${id}`,
      headers: HX_FRAGMENT,
    });
    expect(res.statusCode).toBe(200);
    expect(hxLocationPath(res)).toBe('/trips');
    for (const table of [tripOutfit, tripItem, tripGarmentPacked] as const) {
      expect(
        (
          await t.db
            .select({ n: count() })
            .from(table)
            .where(eq(table.tripId, id))
        )[0].n,
      ).toBe(0);
    }
    expect(await t.db.$count(trip, eq(trip.id, id))).toBe(0);
    expect((await get(`/outfits/${dayOutfit}`)).statusCode).toBe(200);
  });
});
