import { and, eq } from 'drizzle-orm';
import type { RouteOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, type IsoDate } from '../../src/calendar-date';
import {
  garment,
  garmentWear,
  outfitCalendar,
  tripGarmentPacked,
  tripItem,
} from '../../src/db/schema';
import { QUEUEABLE_ROUTES } from '../../src/offline-writes';
import { createGarment } from './garments';
import { createTestApp, recordQueries, type TestApp } from './harness';

/**
 * The server half of offline queued writes (#178a,
 * docs/plans/2026-11-12-offline-queued-writes.md section 4): the five
 * queueable routes take a replay (`X-Closet-Queued: <account>`,
 * `Idempotency-Key`), answer it 204 `changed | unchanged`, apply it twice
 * as once, date a wear or wash by the tap's day within the window, never
 * move a wash back, refuse another account's replay and keep a gone
 * target's 404. A tap without the header is the routes' own specs'
 * (wears, calendar, trips), unchanged.
 */

type Fields = Record<string, string | readonly string[]>;
const KEY = '1a2b3c4d-0000-4000-8000-000000000001';

describe('queued writes', () => {
  let t: TestApp;
  const registered: RouteOptions[] = [];
  let shirt: number;
  let jeans: number;

  const post = (url: string, fields: Fields, headers: object = {}) => {
    const body = new URLSearchParams();
    for (const [name, value] of Object.entries(fields)) {
      for (const item of [value].flat()) body.append(name, item);
    }
    return t.inject({
      method: 'POST',
      url,
      payload: body.toString(),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...headers,
      },
    });
  };
  /** A replay as the outbox sends it: a fetch naming the account and key. */
  const replay = (url: string, fields: Fields, account = t.owner.id) =>
    post(url, fields, {
      'x-closet-queued': String(account),
      'idempotency-key': KEY,
      'sec-fetch-mode': 'cors',
    });
  const outcome = (res: { statusCode: number; headers: object }) => [
    res.statusCode,
    (res.headers as Record<string, unknown>)['x-closet-outcome'],
  ];
  const daysAgo = (days: number): IsoDate => addDays(t.today(), -days);

  const wearDays = async (garmentId: number) =>
    (
      await t.db
        .select({ day: garmentWear.day })
        .from(garmentWear)
        .where(eq(garmentWear.garmentId, garmentId))
    )
      .map((row) => row.day)
      .sort();
  const lastWashed = async (garmentId: number) =>
    (
      await t.db
        .select({ day: garment.lastWashedOn })
        .from(garment)
        .where(eq(garment.id, garmentId))
    )[0]?.day;

  const newOutfit = async (garmentIds: number[]) => {
    const res = await post('/outfits', {
      name: 'Queued look',
      category: garmentIds.map(() => 'tops'),
      garmentId: garmentIds.map(String),
    });
    expect(res.statusCode).toBe(302);
    return Number(/^\/outfits\/(\d+)/.exec(String(res.headers.location))![1]);
  };
  const newEntry = async (outfitId: number, day: IsoDate) => {
    expect(
      (await post('/calendar', { outfitId: String(outfitId), date: day }))
        .statusCode,
    ).toBe(302);
    const [entry] = await t.db
      .select({ id: outfitCalendar.id })
      .from(outfitCalendar)
      .where(
        and(eq(outfitCalendar.outfitId, outfitId), eq(outfitCalendar.day, day)),
      );
    return entry.id;
  };
  const newTrip = async (outfitId: number) => {
    const res = await post('/trips', {
      name: 'Queued trip',
      destination: '',
      startsOn: t.today(),
      endsOn: addDays(t.today(), 2),
      notes: '',
    });
    expect(res.statusCode).toBe(303);
    const id = Number(/^\/trips\/(\d+)/.exec(String(res.headers.location))![1]);
    expect(
      (
        await post(`/trips/${id}/outfits`, {
          outfitId: String(outfitId),
          day: '',
          occasion: '',
        })
      ).statusCode,
    ).toBe(303);
    return id;
  };
  const packedOf = async (tripId: number) =>
    (
      await t.db
        .select({ id: tripGarmentPacked.garmentId })
        .from(tripGarmentPacked)
        .where(eq(tripGarmentPacked.tripId, tripId))
    )
      .map((row) => row.id)
      .sort((a, b) => a - b);

  beforeAll(async () => {
    t = await createTestApp({}, { onRoute: (route) => registered.push(route) });
    shirt = await createGarment(t, { name: 'Queued shirt' });
    jeans = await createGarment(t, {
      name: 'Queued jeans',
      category: 'bottoms',
    });
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  it('marks exactly the listed routes queueable', () => {
    const marked = Object.fromEntries(
      registered
        .filter((route) => route.config?.queueable !== undefined)
        .map((route) => [
          route.config!.queueable,
          `${String(route.method)} ${route.url}`,
        ]),
    );
    expect(marked).toEqual(
      Object.fromEntries(
        Object.entries(QUEUEABLE_ROUTES).map(([kind, url]) => [
          kind,
          `POST ${url}`,
        ]),
      ),
    );
  });

  it('applies a replayed Wore today on the tap’s day, twice as once, and its undo', async () => {
    const url = `/wardrobe/${shirt}/wear`;
    const day = daysAgo(3);
    const wear = { worn: '1', day, clientId: KEY };
    expect(outcome(await replay(url, wear))).toEqual([204, 'changed']);
    expect(outcome(await replay(url, wear))).toEqual([204, 'unchanged']);
    expect(await wearDays(shirt)).toEqual([day]);
    expect(t.logs.messages('info', 'Web')).toContain(
      `Garment ${shirt} worn on ${day} by user ${t.owner.id} (replayed, key 1a2b3c4d)`,
    );
    // Last write wins: the undo queued after it unwears that day.
    expect(outcome(await replay(url, { worn: '0', day }))).toEqual([
      204,
      'changed',
    ]);
    expect(await wearDays(shirt)).toEqual([]);
  });

  it('refuses a day outside the window, 409 with its reason, nothing written', async () => {
    const url = `/wardrobe/${shirt}/wear`;
    expect(outcome(await replay(url, { worn: '1', day: daysAgo(8) }))).toEqual([
      409,
      'too-old',
    ]);
    expect(
      outcome(await replay(`/wardrobe/${shirt}/washed`, { day: daysAgo(-1) })),
    ).toEqual([409, 'future']);
    expect(await wearDays(shirt)).toEqual([]);
    expect(await lastWashed(shirt)).toBeNull();
  });

  it('never moves a wash back: a late replay of an older one is unchanged', async () => {
    const url = `/wardrobe/${jeans}/washed`;
    expect(outcome(await replay(url, { day: daysAgo(2) }))).toEqual([
      204,
      'changed',
    ]);
    expect(outcome(await replay(url, { day: daysAgo(2) }))).toEqual([
      204,
      'unchanged',
    ]);
    expect(outcome(await replay(url, { day: daysAgo(5) }))).toEqual([
      204,
      'unchanged',
    ]);
    expect(await lastWashed(jeans)).toBe(daysAgo(2));
    // A tap still washes today, the day it answers the garment page for.
    expect((await post(url, {})).statusCode).toBe(303);
    expect(await lastWashed(jeans)).toBe(t.today());
  });

  it('replays an entry worn, twice as once, and its undo', async () => {
    const entry = await newEntry(await newOutfit([shirt]), daysAgo(1));
    const url = `/calendar/${entry}/worn`;
    expect(outcome(await replay(url, { worn: '1' }))).toEqual([204, 'changed']);
    expect(outcome(await replay(url, { worn: '1' }))).toEqual([
      204,
      'unchanged',
    ]);
    expect(await wearDays(shirt)).toEqual([daysAgo(1)]);
    expect(outcome(await replay(url, { worn: '0' }))).toEqual([204, 'changed']);
    expect(await wearDays(shirt)).toEqual([]);
  });

  it('replays a packing tick as just its item, beside another tick', async () => {
    const tripId = await newTrip(await newOutfit([shirt, jeans]));
    const url = `/trips/${tripId}/packed`;
    const tick = { packed: [String(shirt)], shown: [String(shirt)] };
    expect(outcome(await replay(url, tick))).toEqual([204, 'changed']);
    expect(outcome(await replay(url, tick))).toEqual([204, 'unchanged']);
    // Jeans ticked on another device; the shirt's untick replayed after.
    await post(url, { packed: [String(jeans)], shown: [String(jeans)] });
    expect(outcome(await replay(url, { shown: [String(shirt)] }))).toEqual([
      204,
      'changed',
    ]);
    expect(await packedOf(tripId)).toEqual([jeans]);

    await post(`/trips/${tripId}/items`, { label: 'Charger' });
    const [{ id: itemId }] = await t.db
      .select({ id: tripItem.id })
      .from(tripItem)
      .where(eq(tripItem.tripId, tripId));
    const items = `/trips/${tripId}/items/packed`;
    const itemTick = { packed: [String(itemId)], shown: [String(itemId)] };
    expect(outcome(await replay(items, itemTick))).toEqual([204, 'changed']);
    expect(outcome(await replay(items, itemTick))).toEqual([204, 'unchanged']);
  });

  it('refuses another account’s replay, 409 account, nothing written', async () => {
    const entry = await newEntry(await newOutfit([jeans]), t.today());
    for (const [url, fields] of [
      [`/wardrobe/${jeans}/wear`, { worn: '1' }],
      [`/calendar/${entry}/worn`, { worn: '1' }],
    ] as const) {
      expect(outcome(await replay(url, fields, t.owner.id + 1000))).toEqual([
        409,
        'account',
      ]);
    }
    expect(await wearDays(jeans)).toEqual([]);
    expect(t.logs.messages('warn', 'Web')).toContain(
      `Queued wear for account ${t.owner.id + 1000} refused: signed in as user ${t.owner.id} (replayed, key 1a2b3c4d)`,
    );
  });

  it('answers a gone garment, entry and trip 404, and keeps the CSRF and session gates', async () => {
    const gone = await createGarment(t, { name: 'Gone shirt' });
    const entry = await newEntry(await newOutfit([gone]), t.today());
    const tripId = await newTrip(await newOutfit([gone]));
    expect(
      (await t.inject({ method: 'DELETE', url: `/wardrobe/${gone}` }))
        .statusCode,
    ).toBeLessThan(400);
    expect(
      (await t.inject({ method: 'DELETE', url: `/trips/${tripId}` }))
        .statusCode,
    ).toBeLessThan(400);
    expect((await post(`/calendar/${entry}/delete`, {})).statusCode).toBe(303);
    for (const [url, fields] of [
      [`/wardrobe/${gone}/wear`, { worn: '1' }],
      [`/wardrobe/${gone}/washed`, {}],
      [`/calendar/${entry}/worn`, { worn: '1' }],
      [`/trips/${tripId}/packed`, { shown: [String(gone)] }],
      [`/trips/${tripId}/items/packed`, { shown: ['1'] }],
    ] as const) {
      expect((await replay(url, fields)).statusCode, url).toBe(404);
    }
    const url = `/wardrobe/${shirt}/wear`;
    const noOrigin = await t.inject({
      method: 'POST',
      url,
      payload: 'worn=1',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-closet-queued': String(t.owner.id),
      },
      sameOrigin: false,
    });
    expect(noOrigin.statusCode).toBe(403);
    const signedOut = await t.inject({
      method: 'POST',
      url,
      payload: 'worn=1',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-closet-queued': String(t.owner.id),
        'sec-fetch-mode': 'cors',
      },
      anonymous: true,
    });
    expect(signedOut.statusCode).toBe(401);
    expect(await wearDays(shirt)).toEqual([]);
  });

  it('costs a replay the writer’s statements and the session, no answer read', async () => {
    const entry = await newEntry(await newOutfit([shirt]), t.today());
    const tripId = await newTrip(await newOutfit([shirt]));
    const counted: [url: string, fields: Fields, statements: number][] = [
      [`/wardrobe/${shirt}/wear`, { worn: '1' }, 2],
      [`/wardrobe/${shirt}/washed`, {}, 2],
      // begin, the owner lock, the entry locked, the change, commit
      [`/calendar/${entry}/worn`, { worn: '1' }, 6],
      [
        `/trips/${tripId}/packed`,
        { packed: [String(shirt)], shown: [String(shirt)] },
        2,
      ],
      [`/trips/${tripId}/items/packed`, { shown: [] }, 2],
    ];
    for (const [url, fields, statements] of counted) {
      let status = 0;
      const record = await recordQueries(async () => {
        status = (await replay(url, fields)).statusCode;
      });
      expect([status, record.statements], url).toEqual([204, statements]);
    }
  });
});
