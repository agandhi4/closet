import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { count, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Garment } from '../../src/dal/entity/garment.entity';
import { User } from '../../src/dal/entity/user.entity';
import { outfit, outfitCalendar, outfitSlot } from '../../src/db/schema';
import { LOGIN_PATH } from '../../src/auth/session-access';
import { createGarment, jpegPhoto, pngCutout, uploadPhoto } from './garments';
import { createTestApp, multipart, TestApp } from './harness';

/**
 * The object-level authorization matrix. One owner (the harness's default
 * user) holds a garment (with a photo), an outfit and a calendar entry; every
 * route that takes one of their ids (plus the `?ownerId=` wardrobe routes)
 * is requested by the owner, a MANAGE grantee, a VIEW grantee, a registered
 * stranger and an anonymous visitor, with and without `?ownerId=<owner>`.
 * Each case asserts the status (or redirect), that refused requests leak
 * no names into the body, and that a refused write changed no row and no
 * stored file. Sharing covers garments only: outfits and calendar entries
 * stay private to their owner whatever the share.
 *
 * Refusals follow WardrobeAccess (src/web/sharing/access.ts): what the
 * requester cannot see does not exist for them, a 404 like an unknown id (a
 * stranger's view of the owner's wardrobe, a garment outside the addressed
 * wardrobe, anyone else's outfit), so ids reveal nothing; what they can see
 * but may not change is a 403 (a VIEW grantee writing, a grantee archiving).
 * Calendar entries and outfits are never shared, so every refusal there is
 * a 404.
 */

type SignedIn = 'owner' | 'manager' | 'viewer' | 'stranger';
type ActorName = SignedIn | 'anonymous';
/** own: the URL as the app links it; ownerId: `?ownerId=<owner>` appended. */
type Via = 'own' | 'ownerId';

/**
 * ok: the route's success status. Reads that `show` their subject must
 *     render its name; writes must change stored data; clones must add a
 *     garment to the requester's wardrobe and modify nothing that existed.
 * hidden: 200, but the requester's own data only (no owner names).
 * forbidden / notFound / login: refused, nothing leaked, nothing changed.
 */
type Outcome = 'ok' | 'hidden' | 'forbidden' | 'notFound' | 'login';

interface Fixture {
  garmentId: number;
  garmentName: string;
  outfitId: number;
  outfitName: string;
  entryId: number;
}

interface Route {
  name: string;
  kind: 'read' | 'write' | 'clone';
  /** Status the route answers on success (Nest POSTs default to 201). */
  ok: number;
  /** Text naming the owner's row: must appear on success, never on a refusal. */
  secret: (f: Fixture) => string;
  /** Success renders the secret (detail pages, lists, forms). */
  shows?: boolean;
  vias: Via[];
  request: (
    f: Fixture,
    ownerQuery: string,
  ) => InjectOptions | Promise<InjectOptions>;
  /** Per signed-in actor, one outcome for every via or one per via. */
  expect: Record<SignedIn, Outcome | Outcome[]>;
}

const BOTH: Via[] = ['own', 'ownerId'];
const garmentName = (f: Fixture) => f.garmentName;
const outfitName = (f: Fixture) => f.outfitName;
// A calendar chip whose outfit has photos shows thumbnails, not the name,
// so the chip's link stands in for it. (Error pages echo the request path,
// which rules out the /calendar/:id URLs themselves.)
const calendarEntry = (f: Fixture) =>
  `/outfits/${f.outfitId}/edit?returnTo=/calendar`;
const today = () => new Date().toISOString().slice(0, 10);

let photo: Buffer;
let cutout: Buffer;

const ROUTES: Route[] = [
  // Wardrobe-level routes: the only id they take is ?ownerId.
  {
    name: 'GET /wardrobe',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    shows: true,
    vias: BOTH,
    request: (_, q) => ({ method: 'GET', url: `/wardrobe${q}` }),
    expect: {
      owner: 'ok',
      manager: ['hidden', 'ok'],
      viewer: ['hidden', 'ok'],
      stranger: ['hidden', 'notFound'],
    },
  },
  {
    name: 'GET /wardrobe/new',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    vias: ['ownerId'],
    request: (_, q) => ({ method: 'GET', url: `/wardrobe/new${q}` }),
    expect: {
      owner: 'ok',
      manager: 'ok',
      viewer: 'forbidden',
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /wardrobe',
    kind: 'write',
    ok: 302,
    secret: garmentName,
    vias: ['ownerId'],
    request: (_, q) => ({
      method: 'POST',
      url: `/wardrobe${q}`,
      payload: { name: 'Planted', category: 'shirt' },
    }),
    expect: {
      owner: 'ok',
      manager: 'ok',
      viewer: 'forbidden',
      stranger: 'notFound',
    },
  },

  // Garment routes. Without ?ownerId a grantee addresses their own wardrobe,
  // which does not hold the owner's garment.
  {
    name: 'GET /wardrobe/:id',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({ method: 'GET', url: `/wardrobe/${f.garmentId}${q}` }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'ok'],
      stranger: 'notFound',
    },
  },
  {
    name: 'GET /wardrobe/:id/edit',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/wardrobe/${f.garmentId}/edit${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
  },
  {
    // A VIEW grantee may clone (audit L3): the copy lands in the grantee's
    // own wardrobe and the owner's data is only read. The garment page hides
    // the button from them (canClone = canManage); the routes allow it.
    name: 'GET /wardrobe/:id/clone',
    kind: 'read',
    ok: 200,
    secret: garmentName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/wardrobe/${f.garmentId}/clone${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'ok'],
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /wardrobe/:id/clone',
    kind: 'clone',
    ok: 302,
    secret: garmentName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/${f.garmentId}/clone${q}`,
      payload: { name: 'Cloned', category: 'shirt' },
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'ok'],
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /wardrobe/:id',
    kind: 'write',
    ok: 302,
    secret: garmentName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/${f.garmentId}${q}`,
      payload: { name: 'Edited', category: 'pants' },
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
  },
  {
    // Without ?ownerId the bytes are stored before the ownership check fails;
    // the snapshot includes DATA_PATH, so it also proves they are removed.
    name: 'POST /wardrobe/:id/photo',
    kind: 'write',
    ok: 201,
    secret: garmentName,
    vias: BOTH,
    request: async (f, q) => {
      const body = await multipart(
        {},
        {
          photo: {
            data: photo,
            filename: 'photo.jpg',
            contentType: 'image/jpeg',
          },
        },
      );
      return {
        method: 'POST',
        url: `/wardrobe/${f.garmentId}/photo${q}`,
        ...body,
      };
    },
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /wardrobe/:id/nobg',
    kind: 'write',
    ok: 201,
    secret: garmentName,
    vias: BOTH,
    request: async (f, q) => {
      const body = await multipart(
        {},
        {
          nobgPhoto: {
            data: cutout,
            filename: 'cutout.png',
            contentType: 'image/png',
          },
        },
      );
      return {
        method: 'POST',
        url: `/wardrobe/${f.garmentId}/nobg${q}`,
        ...body,
      };
    },
    expect: {
      owner: 'ok',
      manager: ['notFound', 'ok'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
  },
  {
    // Archive and delete are owner-only, even for a MANAGE grantee.
    name: 'POST /wardrobe/:id/archive',
    kind: 'write',
    ok: 201,
    secret: garmentName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/wardrobe/${f.garmentId}/archive${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'forbidden'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
  },
  {
    name: 'DELETE /wardrobe/:id',
    kind: 'write',
    ok: 200,
    secret: garmentName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'DELETE',
      url: `/wardrobe/${f.garmentId}${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: ['notFound', 'forbidden'],
      viewer: ['notFound', 'forbidden'],
      stranger: 'notFound',
    },
  },

  // Outfits and calendar are not shared and ignore ?ownerId; the ownerId
  // via proves a grantee cannot reach them by naming the owner.
  {
    name: 'GET /outfits',
    kind: 'read',
    ok: 200,
    secret: outfitName,
    shows: true,
    vias: BOTH,
    request: (_, q) => ({ method: 'GET', url: `/outfits${q}` }),
    expect: {
      owner: 'ok',
      manager: 'hidden',
      viewer: 'hidden',
      stranger: 'hidden',
    },
  },
  {
    name: 'GET /outfits/:id',
    kind: 'read',
    ok: 200,
    secret: outfitName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({ method: 'GET', url: `/outfits/${f.outfitId}${q}` }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    name: 'GET /outfits/:id/edit',
    kind: 'read',
    ok: 200,
    secret: outfitName,
    shows: true,
    vias: BOTH,
    request: (f, q) => ({
      method: 'GET',
      url: `/outfits/${f.outfitId}/edit${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /outfits/:id',
    kind: 'write',
    ok: 302,
    secret: outfitName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/outfits/${f.outfitId}${q}`,
      payload: { name: 'Renamed' },
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    name: 'DELETE /outfits/:id',
    kind: 'write',
    ok: 200,
    secret: outfitName,
    vias: BOTH,
    request: (f, q) => ({
      method: 'DELETE',
      url: `/outfits/${f.outfitId}${q}`,
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    name: 'GET /calendar',
    kind: 'read',
    ok: 200,
    secret: calendarEntry,
    shows: true,
    vias: BOTH,
    request: (_, q) => ({ method: 'GET', url: `/calendar${q}` }),
    expect: {
      owner: 'ok',
      manager: 'hidden',
      viewer: 'hidden',
      stranger: 'hidden',
    },
  },
  {
    name: 'POST /calendar',
    kind: 'write',
    ok: 302,
    secret: outfitName,
    vias: BOTH,
    // Not today(): the fixture already planned the outfit today, and
    // scheduling is idempotent, so the same day would change no row.
    request: (f, q) => ({
      method: 'POST',
      url: `/calendar${q}`,
      payload: { date: '2030-10-09', outfitId: String(f.outfitId) },
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /calendar/:id/delete',
    kind: 'write',
    ok: 200,
    secret: calendarEntry,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/calendar/${f.entryId}/delete${q}`,
      payload: { week: today() },
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
  {
    name: 'POST /calendar/:id/worn',
    kind: 'write',
    ok: 303,
    secret: calendarEntry,
    vias: BOTH,
    request: (f, q) => ({
      method: 'POST',
      url: `/calendar/${f.entryId}/worn${q}`,
      payload: { week: today() },
    }),
    expect: {
      owner: 'ok',
      manager: 'notFound',
      viewer: 'notFound',
      stranger: 'notFound',
    },
  },
];

interface Case {
  title: string;
  route: Route;
  actor: ActorName;
  via: Via;
  outcome: Outcome;
}

const CASES: Case[] = ROUTES.flatMap((route) =>
  route.vias.flatMap((via, i) =>
    (['owner', 'manager', 'viewer', 'stranger', 'anonymous'] as const).map(
      (actor): Case => {
        const expected = actor === 'anonymous' ? 'login' : route.expect[actor];
        const outcome = Array.isArray(expected) ? expected[i] : expected;
        const where = via === 'ownerId' ? ' ?ownerId=<owner>' : '';
        return {
          title: `${route.name}${where} as ${actor}: ${outcome}`,
          route,
          actor,
          via,
          outcome,
        };
      },
    ),
  ),
);

describe('authorization matrix', () => {
  let t: TestApp;
  const actors = {} as Record<ActorName, { id?: number; cookie?: string }>;
  /** Read-only and refused cases share it; successful writes get their own. */
  let shared: Fixture;

  const signUp = async (email: string) => {
    const cookie = await t.register(email);
    const { id } = await t.em().findOneOrFail(User, { email });
    return { id, cookie };
  };

  const share = async (grantee: SignedIn, permission: 'VIEW' | 'MANAGE') => {
    const res = await t.inject({
      method: 'POST',
      url: '/wardrobe-share/create-invite-link',
      payload: { permission },
      headers: { cookie: actors.owner.cookie, 'hx-request': 'true' },
    });
    const token = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(res.body);
    if (!token) throw new Error(`No invite URL in partial:\n${res.body}`);
    const accept = await t.inject({
      method: 'POST',
      url: `/wardrobe-share/invite/${token[1]}/accept`,
      headers: { cookie: actors[grantee].cookie },
    });
    expect(accept.headers.location).toBe('/wardrobe-share/manage');
  };

  const createFixture = async (): Promise<Fixture> => {
    const cookie = actors.owner.cookie!;
    const tag = randomUUID().slice(0, 8);
    const garmentName = `Coat ${tag}`;
    const outfitName = `Look ${tag}`;
    const garmentId = await createGarment(t, { name: garmentName, cookie });
    await uploadPhoto(t, garmentId, photo, cookie);

    const outfit = await t.inject({
      method: 'POST',
      url: '/outfits',
      payload: {
        name: outfitName,
        category: 'shirt',
        garmentId: String(garmentId),
      },
      headers: { cookie },
    });
    const outfitId = Number(
      /^\/outfits\/(\d+)$/.exec(outfit.headers.location as string)?.[1],
    );
    expect(outfitId).toBeGreaterThan(0);

    const scheduled = await t.inject({
      method: 'POST',
      url: '/calendar',
      payload: { date: today(), outfitId: String(outfitId) },
      headers: { cookie },
    });
    expect(scheduled.statusCode).toBe(302);
    const [entry] = await t.db
      .select({ id: outfitCalendar.id })
      .from(outfitCalendar)
      .where(eq(outfitCalendar.outfitId, outfitId));
    return { garmentId, garmentName, outfitId, outfitName, entryId: entry.id };
  };

  /**
   * Every row a wardrobe request could touch plus the photo files on disk,
   * one sorted string per row, so a diff names exactly what changed.
   */
  const snapshot = async (): Promise<string[]> => {
    const tables = [
      'garment',
      'file',
      'outfit',
      'outfit_slot',
      'outfit_calendar',
      'wardrobe_share',
    ];
    const rows = await Promise.all(
      tables.map(async (table) => {
        const result = await t.db.execute<Record<string, unknown>>(
          sql.raw(`select * from "${table}"`),
        );
        return result.rows.map((row) => `${table} ${JSON.stringify(row)}`);
      }),
    );
    const stored = (await readdir(t.dataPath))
      .filter((name) => name.endsWith('.webp'))
      .map((name) => `stored ${name}`);
    return [...rows.flat(), ...stored].sort();
  };

  interface Observed {
    actor: ActorName;
    res: LightMyRequestResponse;
    secret: string;
    before: string[];
    after: string[];
  }

  const expectSuccess = async (
    route: Route,
    { actor, res, secret, before, after }: Observed,
  ) => {
    expect(res.statusCode).toBe(route.ok);
    if (route.kind === 'read') {
      if (route.shows) expect(res.body).toContain(secret);
      expect(after).toEqual(before);
    } else if (route.kind === 'write') {
      expect(after).not.toEqual(before);
    } else {
      const cloneId = Number(
        /^\/wardrobe\/(\d+)$/.exec(res.headers.location as string)?.[1],
      );
      const clone = await t
        .em()
        .findOneOrFail(Garment, cloneId, { populate: ['owner'] });
      expect(clone.owner.id).toBe(actors[actor].id);
      // Added rows only: nothing that existed (the source) was modified.
      expect(after).toEqual(expect.arrayContaining(before));
    }
  };

  const REFUSED_STATUS: Record<Exclude<Outcome, 'ok'>, number> = {
    hidden: 200,
    forbidden: 403,
    notFound: 404,
    login: 302,
  };

  const expectRefused = (
    outcome: Exclude<Outcome, 'ok'>,
    { res, secret, before, after }: Observed,
  ) => {
    expect(res.statusCode).toBe(REFUSED_STATUS[outcome]);
    if (outcome === 'login') expect(res.headers.location).toBe(LOGIN_PATH);
    expect(res.body).not.toContain(secret);
    expect(after).toEqual(before);
  };

  beforeAll(async () => {
    t = await createTestApp();
    [photo, cutout] = await Promise.all([
      jpegPhoto(320, 240),
      pngCutout(320, 240),
    ]);
    actors.owner = t.owner;
    actors.manager = await signUp('manager@example.com');
    actors.viewer = await signUp('viewer@example.com');
    actors.stranger = await signUp('stranger@example.com');
    actors.anonymous = {};
    await share('manager', 'MANAGE');
    await share('viewer', 'VIEW');
    shared = await createFixture();
  });

  afterAll(() => t?.cleanup());

  it.each(CASES)('$title', async ({ route, actor, via, outcome }) => {
    const mutates = outcome === 'ok' && route.kind === 'write';
    const fixture = mutates ? await createFixture() : shared;
    const secret = route.secret(fixture);
    const { cookie } = actors[actor];
    const ownerQuery = via === 'ownerId' ? `?ownerId=${actors.owner.id}` : '';
    const request = await route.request(fixture, ownerQuery);

    const before = await snapshot();
    const res = await t.inject({
      ...request,
      headers: { ...request.headers, ...(cookie ? { cookie } : {}) },
      anonymous: actor === 'anonymous',
    });
    const after = await snapshot();

    const observed = { actor, res, secret, before, after };

    if (outcome === 'ok') await expectSuccess(route, observed);
    else expectRefused(outcome, observed);
  });

  // The outfit form posts garment ids; ids outside the requester's own
  // wardrobe are dropped (the row stays, empty), so no outfit can reference
  // a shared garment.
  const slotsOf = async (outfitId: number) => {
    const [row] = await t.db
      .select({ slots: count(), garments: count(outfitSlot.garmentId) })
      .from(outfitSlot)
      .where(eq(outfitSlot.outfitId, outfitId));
    return row;
  };

  it.each(['manager', 'viewer', 'stranger'] as const)(
    "POST /outfits as %s drops the owner's garment ids",
    async (actor) => {
      const res = await t.inject({
        method: 'POST',
        url: `/outfits?ownerId=${actors.owner.id}`,
        payload: {
          name: `Borrowed ${actor}`,
          category: 'shirt',
          garmentId: String(shared.garmentId),
        },
        headers: { cookie: actors[actor].cookie },
      });
      expect(res.statusCode).toBe(302);
      const outfitId = Number(
        /^\/outfits\/(\d+)$/.exec(res.headers.location as string)?.[1],
      );
      const [created] = await t.db
        .select({ ownerId: outfit.ownerId })
        .from(outfit)
        .where(eq(outfit.id, outfitId));
      expect(created.ownerId).toBe(actors[actor].id);
      expect(await slotsOf(outfitId)).toEqual({ slots: 1, garments: 0 });

      const edit = await t.inject({
        method: 'POST',
        url: `/outfits/${outfitId}`,
        payload: { category: 'shirt', garmentId: String(shared.garmentId) },
        headers: { cookie: actors[actor].cookie },
      });
      expect(edit.statusCode).toBe(302);
      expect(await slotsOf(outfitId)).toEqual({ slots: 1, garments: 0 });
    },
  );
});
