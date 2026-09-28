import { and, asc, count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  outfit,
  outfitCalendar,
  outfitSlot,
  tripOutfit,
} from '../../src/db/schema';
import { addDays } from '../../src/web/calendar/calendar-date';
import { createGarment, createWishlistItem } from './garments';
import {
  createTestApp,
  hasText,
  recordQueries,
  TestApp,
  unescapeHtml,
  userIdOf,
} from './harness';
import {
  expectFragment,
  expectFullPage,
  expectNativePostForms,
  HX_FRAGMENT,
} from './pages';

/**
 * Styling (#42), the composer that replaced the outfit builder: rows by
 * role over the wardrobe's closet, each a strip whose window the page
 * reads; Shuffle through the generator with the locked rows; "Add row";
 * Save through the outfit writers (pickIdea by destination, updateOutfit
 * for an edit), once however often it is posted; the builder's old
 * addresses redirected; and a shared wardrobe browsed, never saved into.
 */

type Row = [role: string, garmentId: number | null, locked: boolean];

/** The rows as the page posts them: role, garmentId and lock, in document order. */
function rowsOf(html: string): Row[] {
  const roles = [...html.matchAll(/name="role" value="([^"]*)"/g)].map(
    (m) => m[1],
  );
  const garments = [...html.matchAll(/name="garmentId" value="([^"]*)"/g)].map(
    (m) => (m[1] ? Number(m[1]) : null),
  );
  const locks = [...html.matchAll(/name="lock" value="([^"]*)"/g)].map(
    (m) => m[1] === '1',
  );
  expect(garments).toHaveLength(roles.length);
  expect(locks).toHaveLength(roles.length);
  return roles.map((role, i) => [role, garments[i], locks[i]]);
}

/** The first `role` row's markup. */
function rowOf(html: string, role: string): string {
  const start = html.indexOf(`data-styling-row="${role}"`);
  expect(start, `a ${role} row`).toBeGreaterThan(-1);
  const end = html.indexOf('data-styling-row="', start + 1);
  return html.slice(start, end === -1 ? undefined : end);
}

/** A row's strip: the garment ids after "No garment", in order. */
function stripOf(html: string, role: string): number[] {
  return [...rowOf(html, role).matchAll(/data-garment-id="(\d+)"/g)].map((m) =>
    Number(m[1]),
  );
}

/**
 * The strip's items the keyboard and assistive tech can reach (#146): the
 * ones not inert. A garment by its id, "No garment" as null.
 */
function reachableOf(html: string, role: string): (number | null)[] {
  return [...rowOf(html, role).matchAll(/<(?:a|button) [^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => tag.includes('styling-item') && !tag.includes(' inert'))
    .map((tag) => {
      const id = /data-garment-id="(\d*)"/.exec(tag)![1];
      return id ? Number(id) : null;
    });
}

/** The rows' fields as Shuffle and "Add row" send them (a GET query). */
function rowsQuery(rows: Row[], extra: Record<string, string> = {}): string {
  const query = new URLSearchParams(extra);
  for (const [role, garmentId, locked] of rows) {
    query.append('role', role);
    query.append('garmentId', garmentId === null ? '' : String(garmentId));
    query.append('lock', locked ? '1' : '');
  }
  return query.toString();
}

describe('Styling', () => {
  let t: TestApp;
  let ownerId: number;
  let tops: number[];
  let bottoms: number[];
  let shoes: number[];
  let jacket: number;
  let belt: number;
  let dress: number;
  let umbrella: number;
  let dirtyTee: number;
  let wishlistTee: number;
  let capsuleId: number;
  let viewer: string;
  let stranger: string;

  const form = (payload: Record<string, string | string[]>) => {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(payload)) {
      for (const one of [value].flat()) body.append(key, one);
    }
    return {
      payload: body.toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    };
  };

  const get = (url: string, cookie?: string) =>
    t.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });

  const save = (
    payload: Record<string, string | string[]>,
    cookie?: string,
  ) => {
    const request = form(payload);
    return t.inject({
      method: 'POST',
      url: '/styling',
      payload: request.payload,
      headers: { ...request.headers, ...(cookie ? { cookie } : {}) },
    });
  };

  const garmentIn = async (
    name: string,
    category: string,
    color: string,
  ): Promise<number> => {
    const res = await t.inject({
      method: 'POST',
      url: '/wardrobe',
      ...form({
        name,
        category,
        props: '1',
        formality: '2',
        pattern: 'solid',
        color,
      }),
    });
    expect(res.statusCode).toBe(302);
    return Number(
      /^\/wardrobe\/(\d+)\?/.exec(String(res.headers.location))![1],
    );
  };

  const outfitCount = async () =>
    (await t.db.select({ n: count() }).from(outfit))[0].n;

  const slotsOf = (outfitId: number) =>
    t.db
      .select({
        category: outfitSlot.category,
        garmentId: outfitSlot.garmentId,
      })
      .from(outfitSlot)
      .where(eq(outfitSlot.outfitId, outfitId))
      .orderBy(asc(outfitSlot.position));

  const outfitIdFrom = (location: unknown): number => {
    const match = /^\/outfits\/(\d+)/.exec(String(location));
    if (!match) throw new Error(`Unexpected redirect: ${String(location)}`);
    return Number(match[1]);
  };

  const share = async (cookie: string) => {
    const invite = await t.inject({
      method: 'POST',
      url: '/wardrobe-share/create-invite-link',
      payload: { permission: 'VIEW' },
      headers: { 'hx-request': 'true' },
    });
    const token = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(
      invite.body,
    )![1];
    const accepted = await t.inject({
      method: 'POST',
      url: `/wardrobe-share/invite/${token}/accept`,
      payload: {},
      headers: { cookie },
    });
    expect(accepted.statusCode).toBeLessThan(400);
  };

  beforeAll(async () => {
    t = await createTestApp();
    ownerId = await userIdOf(t, 'owner@example.com');
  });

  afterAll(() => t?.cleanup());

  // Runs first, while the wardrobe is empty.
  it('asks for garments before there are any to style', async () => {
    const res = await get('/styling');
    expect(res.statusCode).toBe(200);
    expectFullPage(res);
    expect(
      hasText(
        res.body,
        'Add some garments to your wardrobe to start styling outfits.',
      ),
    ).toBe(true);
    expect(res.body).not.toContain('id="styling-form"');
  });

  describe('with a wardrobe', () => {
    beforeAll(async () => {
      tops = [
        await garmentIn('White tee', 'tops', 'white'),
        await garmentIn('Grey tee', 'tops', 'grey'),
      ];
      bottoms = [
        await garmentIn('Raw jeans', 'bottoms', 'blue'),
        await garmentIn('Khaki chinos', 'bottoms', 'beige'),
      ];
      shoes = [await garmentIn('White sneakers', 'footwear', 'white')];
      jacket = await garmentIn('Chore coat', 'outerwear', 'beige');
      belt = await garmentIn('Brown belt', 'accessories', 'brown');
      dress = await garmentIn('Black dress', 'dresses', 'black');
      umbrella = await garmentIn('Umbrella', 'umbrellas', 'black');
      // Worn today: in the closet (its row cycles it), never drawn.
      dirtyTee = await garmentIn('Worn tee', 'tops', 'black');
      const wore = await t.inject({
        method: 'POST',
        url: `/wardrobe/${dirtyTee}/wear`,
        ...form({ worn: '1' }),
      });
      expect(wore.statusCode).toBe(303);
      wishlistTee = await createWishlistItem(t, { name: 'Wanted tee' });
      const capsule = await t.inject({
        method: 'POST',
        url: '/capsules',
        ...form({ name: 'Weekend', notes: '' }),
      });
      capsuleId = Number(
        /^\/capsules\/(\d+)/.exec(String(capsule.headers.location))![1],
      );
      const members = await t.inject({
        method: 'POST',
        url: `/capsules/${capsuleId}/garments`,
        ...form({
          ids: [String(tops[0]), String(bottoms[1])],
          shown: [String(tops[0]), String(bottoms[1])],
        }),
      });
      expect(members.statusCode).toBe(303);
      viewer = await t.register('viewer-styling@example.com');
      stranger = await t.register('stranger-styling@example.com');
      await share(viewer);
    });

    describe('GET /styling', () => {
      it('stacks a row per role top to toe, the newest of each worn role chosen', async () => {
        const res = await get('/styling');
        expect(res.statusCode).toBe(200);
        expectFullPage(res);
        expectNativePostForms(res);
        expect(res.body).toMatch(/<h1[^>]*>Styling<\/h1>/);
        expect(rowsOf(res.body)).toEqual([
          ['layer', jacket, false],
          // A dress beside separates starts empty.
          ['one-piece', null, false],
          ['top', dirtyTee, false],
          ['bottom', bottoms[1], false],
          ['footwear', shoes[0], false],
          // Accessories and the uncategorised ride along, empty at first.
          ['accessory', null, false],
          ['none', null, false],
        ]);
        // The strips: every closet garment of the role, newest first; the
        // wishlist item is in none.
        expect(stripOf(res.body, 'top')).toEqual([dirtyTee, tops[1], tops[0]]);
        expect(stripOf(res.body, 'none')).toEqual([umbrella]);
        expect(res.body).not.toContain(`data-garment-id="${wishlistTee}"`);
        // Save opens the sheet; the dock lights Style.
        expect(res.body).toContain('id="styling-save"');
        expect(res.body).toMatch(
          /<a class="dock-active" aria-current="page" href="\/styling">/,
        );
      });

      // A tab root the worker opens stale (page-cache.ts): the same bytes
      // until the wardrobe changes, so nothing of the day's seed.
      it('renders the fresh stack byte for byte the same, without a seed', async () => {
        const first = await get('/styling');
        const second = await get('/styling');
        expect(second.body).toBe(first.body);
        expect(first.body).not.toContain('name="seed"');
      });

      it('reads a window of each strip, whatever the wardrobe holds', async () => {
        const load = () => get('/styling');
        await load();
        const before = await recordQueries(load);
        const socks: number[] = [];
        for (let i = 0; i < 12; i++) {
          socks.push(
            await createGarment(t, {
              name: `Sock ${i}`,
              category: 'accessories',
            }),
          );
        }
        const after = await recordQueries(load);
        expect(after.statements).toBe(before.statements);

        const page = unescapeHtml((await load()).body);
        // 10 of the 13 accessories, then a sentinel for the rest.
        const shown = stripOf(page, 'accessory');
        expect(shown).toEqual(socks.slice(-10).reverse());
        const more = /hx-get="(\/styling\/garments\?[^"]*)"/.exec(page)?.[1];
        expect(more).toBe(
          `/styling/garments?role=accessory&before=${socks[2]}`,
        );

        const next = await t.inject({
          method: 'GET',
          url: more!,
          headers: HX_FRAGMENT,
        });
        expect(next.statusCode).toBe(200);
        expectFragment(next);
        const rest = [...next.body.matchAll(/data-garment-id="(\d+)"/g)].map(
          (m) => Number(m[1]),
        );
        expect(rest).toEqual([socks[1], socks[0], belt]);
        expect(next.body).not.toContain('/styling/garments');
        // The request does not carry the row's lock: styling.js makes these
        // inert as they land in a locked row.
        expect(next.body).not.toContain(' inert');
      });

      it('?capsule= cycles only its garments; not an id is a 400, not the wardrobe’s a 404', async () => {
        const res = await get(`/styling?capsule=${capsuleId}`);
        expect(res.statusCode).toBe(200);
        expect(rowsOf(res.body)).toEqual([
          ['top', tops[0], false],
          ['bottom', bottoms[1], false],
        ]);
        expect(res.body).toContain(`name="capsule" value="${capsuleId}"`);
        expect((await get('/styling?capsule=abc')).statusCode).toBe(400);
        expect(
          (await get(`/styling?capsule=${capsuleId}`, stranger)).statusCode,
        ).toBe(404);
      });

      it('?with= ("Style this") locks the garment and opens on an idea around it', async () => {
        const res = await get(`/styling?with=${bottoms[0]}`);
        expect(res.statusCode).toBe(200);
        const rows = rowsOf(res.body);
        expect(rows).toContainEqual(['bottom', bottoms[0], true]);
        // Locked from the first paint: its neighbours are inert in the
        // server's markup, so Tab reaches the chosen garment alone. An
        // unlocked row's items are all reachable.
        expect(reachableOf(res.body, 'bottom')).toEqual([bottoms[0]]);
        expect(reachableOf(res.body, 'top')).toEqual([
          null,
          ...stripOf(res.body, 'top'),
        ]);
        // The generator's idea fills the other worn rows: a clean top and
        // the shoes; never the dirty tee, never a dress beside jeans.
        const top = rows.find(([role]) => role === 'top')![1];
        expect([tops[0], tops[1]]).toContain(top);
        expect(rows).toContainEqual(['footwear', shoes[0], false]);
        expect(rows).toContainEqual(['one-piece', null, false]);
        expect(res.body).toMatch(/name="seed" value="\d+"/);
        // The same day opens on the same idea.
        expect(rowsOf((await get(`/styling?with=${bottoms[0]}`)).body)).toEqual(
          rows,
        );
      });

      it('?with= refuses a garment outside the closet', async () => {
        expect((await get(`/styling?with=${wishlistTee}`)).statusCode).toBe(
          404,
        );
        expect((await get('/styling?with=999999')).statusCode).toBe(404);
        expect(
          (await get(`/styling?with=${tops[0]}`, stranger)).statusCode,
        ).toBe(404);
      });
    });

    describe('Shuffle and "Add row"', () => {
      const shuffle = (rows: Row[], extra: Record<string, string> = {}) =>
        t.inject({
          method: 'GET',
          url: `/styling/shuffle?${rowsQuery(rows, extra)}`,
          headers: HX_FRAGMENT,
        });

      const fresh: () => Row[] = () => [
        ['layer', jacket, false],
        ['one-piece', null, false],
        ['top', tops[1], true],
        ['bottom', bottoms[1], false],
        ['footwear', shoes[0], false],
        ['accessory', belt, false],
        ['none', null, false],
      ];

      it('fills the unlocked rows from the generator, keeps the locked and the accessories', async () => {
        const res = await shuffle(fresh(), { seed: '7' });
        expect(res.statusCode).toBe(200);
        expectFragment(res);
        expect(res.body).toMatch(/^<div id="styling-rows"/);
        const rows = rowsOf(res.body);
        expect(rows).toContainEqual(['top', tops[1], true]);
        expect(reachableOf(res.body, 'top')).toEqual([tops[1]]);
        expect(reachableOf(res.body, 'footwear')).toEqual([
          null,
          ...stripOf(res.body, 'footwear'),
        ]);
        expect(rows).toContainEqual(['accessory', belt, false]);
        expect(rows).toContainEqual(['one-piece', null, false]);
        expect(rows).toContainEqual(['footwear', shoes[0], false]);
        const bottom = rows.find(([role]) => role === 'bottom')![1];
        expect(bottoms).toContain(bottom);
        // No forecast here: the generator adds no layer.
        expect(rows).toContainEqual(['layer', null, false]);
        // Seeded: the same state and seed are the same answer, and the
        // answer carries the next seed.
        expect((await shuffle(fresh(), { seed: '7' })).body).toBe(res.body);
        const next = /name="seed" value="(\d+)"/.exec(res.body)![1];
        expect(next).not.toBe('7');
      });

      it('says so when nothing fits the locks', async () => {
        // A locked dress and a locked top: no template holds both.
        const res = await shuffle([
          ['one-piece', dress, true],
          ['top', tops[0], true],
        ]);
        expect(res.statusCode).toBe(200);
        expect(
          hasText(res.body, 'Nothing clean goes with the locked rows'),
        ).toBe(true);
        expect(rowsOf(res.body)).toContainEqual(['one-piece', dress, true]);
      });

      it('drops a posted garment that is not the wardrobe’s, and 400s rows that do not line up', async () => {
        const theirs = await createGarment(t, {
          name: 'Their tee',
          category: 'tops',
          cookie: stranger,
        });
        const res = await shuffle([['top', theirs, true]]);
        expect(res.statusCode).toBe(200);
        expect(res.body).not.toContain(`data-garment-id="${theirs}"`);
        expect(rowsOf(res.body)).toContainEqual([
          'top',
          expect.any(Number),
          false,
        ]);

        const lopsided = await t.inject({
          method: 'GET',
          url: `/styling/shuffle?role=top&garmentId=${tops[0]}`,
          headers: HX_FRAGMENT,
        });
        expect(lopsided.statusCode).toBe(400);
      });

      it('"Add row" answers the rows with one more, in outfit order', async () => {
        const res = await t.inject({
          method: 'GET',
          url: `/styling/row?${rowsQuery(fresh(), { add: 'accessory' })}`,
          headers: HX_FRAGMENT,
        });
        expect(res.statusCode).toBe(200);
        const rows = rowsOf(res.body);
        expect(rows.filter(([role]) => role === 'accessory')).toEqual([
          ['accessory', belt, false],
          ['accessory', null, false],
        ]);
        expect(rows.at(-1)).toEqual(['none', null, false]);
      });
    });

    describe('POST /styling (Save)', () => {
      it('saves the rows as an outfit, top to toe, and a second post finds it', async () => {
        const before = await outfitCount();
        const posted = {
          garmentId: [
            String(shoes[0]),
            '',
            String(tops[0]),
            String(bottoms[0]),
          ],
          name: '  Weekend uniform ',
        };
        const res = await save(posted);
        expect(res.statusCode).toBe(303);
        const id = outfitIdFrom(res.headers.location);
        expect(res.headers.location).toBe(`/outfits/${id}`);
        expect(await slotsOf(id)).toEqual([
          { category: 'tops', garmentId: tops[0] },
          { category: 'bottoms', garmentId: bottoms[0] },
          { category: 'footwear', garmentId: shoes[0] },
        ]);
        const [saved] = await t.db
          .select({ name: outfit.name })
          .from(outfit)
          .where(eq(outfit.id, id));
        expect(saved.name).toBe('Weekend uniform');

        // A double tap: the same garments are the same outfit.
        const again = await save(posted);
        expect(again.headers.location).toBe(`/outfits/${id}?alreadySaved=1`);
        expect(await outfitCount()).toBe(before + 1);
        expect(t.logs.messages('info')).toContainEqual(
          expect.stringMatching(
            new RegExp(
              `^Outfit styled by user ${ownerId}: outfit ${id} of garments`,
            ),
          ),
        );
      });

      it('names an outfit for its garments when the name is blank', async () => {
        const res = await save({
          garmentId: [String(tops[1]), String(bottoms[1])],
          name: '',
        });
        const id = outfitIdFrom(res.headers.location);
        const [saved] = await t.db
          .select({ name: outfit.name })
          .from(outfit)
          .where(eq(outfit.id, id));
        expect(saved.name).toBe('Grey tee, Khaki chinos');
      });

      it('plans it for ?for=’s day and occasion, and goes back to that week', async () => {
        const day = addDays(t.today(), 3);
        const res = await save({
          garmentId: [String(tops[1]), String(bottoms[0])],
          for: `day:${day}`,
          occasion: 'evening',
        });
        expect(res.statusCode).toBe(303);
        expect(res.headers.location).toBe(`/calendar?week=${day}`);
        const entries = await t.db
          .select({ occasion: outfitCalendar.occasion })
          .from(outfitCalendar)
          .where(eq(outfitCalendar.day, day));
        expect(entries).toEqual([{ occasion: 'evening' }]);
      });

      it('plans it on the sheet’s optional day without a destination', async () => {
        const day = addDays(t.today(), 4);
        const res = await save({
          garmentId: [String(dress), String(shoes[0])],
          scheduleDate: day,
          scheduleOccasion: 'work',
        });
        expect(res.headers.location).toBe(`/calendar?week=${day}`);
        const [entry] = await t.db
          .select({ occasion: outfitCalendar.occasion })
          .from(outfitCalendar)
          .where(eq(outfitCalendar.day, day));
        expect(entry.occasion).toBe('work');
      });

      it('takes a planned entry’s place with ?replace=', async () => {
        const day = addDays(t.today(), 5);
        const first = await save({
          garmentId: [String(tops[0]), String(bottoms[1])],
          for: `day:${day}`,
          occasion: 'daytime',
        });
        expect(first.statusCode).toBe(303);
        const [entry] = await t.db
          .select({ id: outfitCalendar.id, outfitId: outfitCalendar.outfitId })
          .from(outfitCalendar)
          .where(eq(outfitCalendar.day, day));
        const res = await save({
          garmentId: [String(tops[1]), String(bottoms[1]), String(shoes[0])],
          for: `day:${day}`,
          occasion: 'daytime',
          replace: String(entry.id),
          name: 'Swapped in',
        });
        expect(res.statusCode).toBe(303);
        expect(res.headers.location).toBe(`/calendar?week=${day}`);
        const [changed] = await t.db
          .select({ outfitId: outfitCalendar.outfitId, name: outfit.name })
          .from(outfitCalendar)
          .innerJoin(outfit, eq(outfit.id, outfitCalendar.outfitId))
          .where(eq(outfitCalendar.id, entry.id));
        expect(changed.outfitId).not.toBe(entry.outfitId);
        expect(changed.name).toBe('Swapped in');
      });

      it('adds it to a trip for its day and occasion', async () => {
        const today = t.today();
        const trip = await t.inject({
          method: 'POST',
          url: '/trips',
          ...form({
            name: 'Lisbon',
            destination: '',
            startsOn: addDays(today, 10),
            endsOn: addDays(today, 12),
            notes: '',
          }),
        });
        const tripId = Number(
          /^\/trips\/(\d+)/.exec(String(trip.headers.location))![1],
        );
        const day = addDays(today, 11);
        const res = await save({
          garmentId: [String(jacket), String(tops[0]), String(bottoms[0])],
          for: `trip:${tripId}:${day}`,
          occasion: 'evening',
        });
        expect(res.statusCode).toBe(303);
        expect(res.headers.location).toBe(`/trips/${tripId}?picked=1`);
        const onTrip = await t.db
          .select({ day: tripOutfit.day, occasion: tripOutfit.occasion })
          .from(tripOutfit)
          .where(eq(tripOutfit.tripId, tripId));
        expect(onTrip).toEqual([{ day, occasion: 'evening' }]);

        // The page aimed at the trip says so, and 404s another's.
        const page = await get(
          `/styling?for=trip:${tripId}:${day}&occasion=evening`,
        );
        expect(page.statusCode).toBe(200);
        expect(page.body).toContain('data-styling-for="trip"');
        expect(page.body).toContain(`name="for" value="trip:${tripId}:${day}"`);
        expect(
          (await get(`/styling?for=trip:${tripId}`, stranger)).statusCode,
        ).toBe(404);
      });

      it.each([
        ['no garment at all', { garmentId: ['', ''] }],
        [
          'a malformed destination',
          { garmentId: ['1'], for: 'day:2026-02-30' },
        ],
        ['a replace without a day', { garmentId: ['1'], replace: '4' }],
        ['a name past its cap', { garmentId: ['1'], name: 'x'.repeat(256) }],
      ])('400s %s and writes nothing', async (_label, payload) => {
        const before = await outfitCount();
        const res = await save(payload);
        expect(res.statusCode).toBe(400);
        expect(await outfitCount()).toBe(before);
      });

      it('refuses garments that are not the requester’s closet', async () => {
        const before = await outfitCount();
        // Their own wishlist item: named, a 409 (#219). A hand-made post
        // without the page's rows gets the error page, not Styling.
        const wanted = await save({ garmentId: [String(wishlistTee)] });
        expect(wanted.statusCode).toBe(409);
        expect(wanted.body).toContain(
          'Not saved: Wanted tee is on your wishlist, not bought yet.',
        );
        expect(wanted.body).not.toContain('id="styling-form"');
        expect(
          (await save({ garmentId: [String(tops[0])] }, stranger)).statusCode,
        ).toBe(404);
        expect(await outfitCount()).toBe(before);
      });
    });

    describe('an outfit opened in Styling (?outfit=)', () => {
      let outfitId: number;
      let archivedCoat: number;

      beforeAll(async () => {
        archivedCoat = await garmentIn('Old parka', 'outerwear', 'black');
        const res = await save({
          garmentId: [
            String(archivedCoat),
            String(tops[0]),
            String(belt),
            String(bottoms[1]),
          ],
          name: 'Autumn',
        });
        outfitId = outfitIdFrom(res.headers.location);
        const archived = await t.inject({
          method: 'POST',
          url: `/wardrobe/${archivedCoat}/archive`,
        });
        expect(archived.statusCode).toBeLessThan(400);
      });

      it('opens on its garments, the archived one kept and marked, every other role empty', async () => {
        const res = await get(`/styling?outfit=${outfitId}`);
        expect(res.statusCode).toBe(200);
        expect(rowsOf(res.body)).toEqual([
          ['layer', archivedCoat, false],
          ['one-piece', null, false],
          ['top', tops[0], false],
          ['bottom', bottoms[1], false],
          ['footwear', null, false],
          ['accessory', belt, false],
          ['none', null, false],
        ]);
        expect(stripOf(res.body, 'layer')[0]).toBe(archivedCoat);
        expect(hasText(res.body, 'Changing Autumn')).toBe(true);
        expect(res.body).toContain(`name="outfit" value="${outfitId}"`);
        expect(res.body).toMatch(/name="name"[^>]*value="Autumn"/);
      });

      it('saving updates that outfit in place, and goes back where it came from', async () => {
        const before = await outfitCount();
        const res = await save({
          outfit: String(outfitId),
          garmentId: [
            String(archivedCoat),
            String(tops[1]),
            String(bottoms[1]),
            String(shoes[0]),
          ],
          name: 'Autumn, sneakers',
          returnTo: '/calendar?week=2030-10-06',
        });
        expect(res.statusCode).toBe(303);
        expect(res.headers.location).toBe('/calendar?week=2030-10-06');
        expect(await outfitCount()).toBe(before);
        expect(await slotsOf(outfitId)).toEqual([
          { category: 'outerwear', garmentId: archivedCoat },
          { category: 'tops', garmentId: tops[1] },
          { category: 'bottoms', garmentId: bottoms[1] },
          { category: 'footwear', garmentId: shoes[0] },
        ]);
        // Saved twice, still one outfit with those slots.
        await save({
          outfit: String(outfitId),
          garmentId: [
            String(archivedCoat),
            String(tops[1]),
            String(bottoms[1]),
            String(shoes[0]),
          ],
          name: 'Autumn, sneakers',
        });
        expect(await outfitCount()).toBe(before);
        expect(await slotsOf(outfitId)).toHaveLength(4);
        expect(t.logs.messages('info')).toContainEqual(
          `Outfit ${outfitId} changed in Styling by user ${ownerId}: garments ${archivedCoat}, ${tops[1]}, ${bottoms[1]}, ${shoes[0]}`,
        );
      });

      it('is the requester’s alone', async () => {
        expect(
          (await get(`/styling?outfit=${outfitId}`, viewer)).statusCode,
        ).toBe(404);
        expect(
          (await get(`/styling?outfit=${outfitId}&ownerId=${ownerId}`, viewer))
            .statusCode,
        ).toBe(404);
        expect((await get('/styling?outfit=999999')).statusCode).toBe(404);
        const res = await save(
          { outfit: String(outfitId), garmentId: [String(tops[0])] },
          stranger,
        );
        expect(res.statusCode).toBe(404);
      });

      it('changes in place only: a trip or an entry to replace is a 400', async () => {
        const res = await save({
          outfit: String(outfitId),
          garmentId: [String(tops[0])],
          for: 'trip:1',
        });
        expect(res.statusCode).toBe(400);
      });
    });

    describe('the builder’s old addresses', () => {
      it.each([
        ['/outfits/new', '/styling'],
        [
          '/outfits/new?for=day:2030-10-09&occasion=evening&returnTo=/calendar',
          '/styling?for=day:2030-10-09&occasion=evening&returnTo=%2Fcalendar',
        ],
        [
          '/outfits/new?scheduleDate=2030-10-09',
          '/styling?for=day:2030-10-09&occasion=all-day',
        ],
        ['/outfits/new?scheduleDate=2030-02-30', '/styling'],
        ['/outfits/new?capsule=12', '/styling?capsule=12'],
        ['/outfits/new?capsule=abc', '/styling'],
        ['/outfits/7/edit', '/styling?outfit=7'],
        [
          '/outfits/7/edit?returnTo=/calendar&returnToWeek=2030-10-06',
          '/styling?outfit=7&returnTo=%2Fcalendar%3Fweek%3D2030-10-06',
        ],
        [
          '/outfits/7/edit?returnTo=/outfits/7',
          '/styling?outfit=7&returnTo=%2Foutfits%2F7',
        ],
      ])('%s redirects to %s', async (from, to) => {
        const res = await get(from);
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe(to);
      });

      it('an old cached builder form still saves through POST /outfits', async () => {
        const res = await t.inject({
          method: 'POST',
          url: '/outfits',
          ...form({
            name: 'Cached form',
            category: ['tops', 'bottoms'],
            garmentId: [String(tops[0]), String(bottoms[0])],
          }),
        });
        expect(res.statusCode).toBe(302);
        const id = outfitIdFrom(res.headers.location);
        expect(await slotsOf(id)).toHaveLength(2);
      });
    });

    describe('a shared wardrobe (VIEW)', () => {
      it('browses the owner’s closet with nothing to save', async () => {
        const res = await get(`/styling?ownerId=${ownerId}`, viewer);
        expect(res.statusCode).toBe(200);
        expectFullPage(res);
        expect(rowsOf(res.body)).toContainEqual(['top', dirtyTee, false]);
        expect(res.body).toContain(`name="ownerId" value="${ownerId}"`);
        expect(res.body).toContain('data-styling-shared');
        expect(res.body).not.toContain('id="styling-save"');
        // Nothing saves, so it is no form page (public/js/back.js).
        expect(res.body).not.toContain('data-form-page');
        // Garment links stay in the shared wardrobe.
        expect(unescapeHtml(res.body)).toContain(
          `href="/wardrobe/${tops[0]}?ownerId=${ownerId}"`,
        );
      });

      it('shuffles from the closet alone: none of the owner’s days, clashes or outfits', async () => {
        const query = rowsQuery(
          [
            ['top', tops[0], true],
            ['bottom', null, false],
            ['footwear', null, false],
          ],
          { ownerId: String(ownerId), seed: '3', for: `day:${t.today()}` },
        );
        const res = await t.inject({
          method: 'GET',
          url: `/styling/shuffle?${query}`,
          headers: { ...HX_FRAGMENT, cookie: viewer },
        });
        expect(res.statusCode).toBe(200);
        const rows = rowsOf(res.body);
        expect(rows).toContainEqual(['top', tops[0], true]);
        expect(bottoms).toContain(rows.find(([role]) => role === 'bottom')![1]);
        expect(t.logs.messages('debug')).toContainEqual(
          expect.stringMatching(
            /^Styling shuffle for user \d+ over wardrobe \d+ \(shared\)/,
          ),
        );
      });

      it('never saves the owner’s garments into the grantee’s outfits', async () => {
        const before = await outfitCount();
        const res = await save(
          {
            garmentId: [String(tops[0]), String(bottoms[0])],
            ownerId: String(ownerId),
          },
          viewer,
        );
        expect(res.statusCode).toBe(404);
        expect(await outfitCount()).toBe(before);
      });

      it('is a 404 to someone it is not shared with', async () => {
        expect(
          (await get(`/styling?ownerId=${ownerId}`, stranger)).statusCode,
        ).toBe(404);
      });
    });

    describe('the way in', () => {
      it('"Style this" on a closet garment opens Styling on it, for its owner and a grantee', async () => {
        const own = unescapeHtml((await get(`/wardrobe/${tops[0]}`)).body);
        expect(own).toContain(`href="/styling?with=${tops[0]}"`);
        const shared = unescapeHtml(
          (await get(`/wardrobe/${tops[0]}?ownerId=${ownerId}`, viewer)).body,
        );
        expect(shared).toContain(
          `href="/styling?with=${tops[0]}&ownerId=${ownerId}"`,
        );
      });

      it('the plan page styles for its day', async () => {
        const plan = unescapeHtml(
          (await get('/calendar/plan?for=day:2030-10-09&occasion=evening'))
            .body,
        );
        expect(plan).toContain(
          'href="/styling?for=day:2030-10-09&occasion=evening"',
        );
      });

      it('the Outfits page and an outfit link into Styling', async () => {
        const list = await get('/outfits');
        expect(list.body).toContain('href="/styling"');
        const [first] = await t.db
          .select({ id: outfit.id })
          .from(outfit)
          .where(and(eq(outfit.ownerId, ownerId)))
          .limit(1);
        const page = unescapeHtml((await get(`/outfits/${first.id}`)).body);
        expect(page).toContain(
          `href="/styling?outfit=${first.id}&returnTo=%2Foutfits%2F${first.id}"`,
        );
      });
    });
  });
});
