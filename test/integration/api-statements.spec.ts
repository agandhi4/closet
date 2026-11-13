import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deviceToken, SIGN_IN_URL, signInDevice } from './api';
import { failCutout } from './cutouts';
import { jpeg, type LinkSites, startLinkSites } from './link-sites';
import {
  createGarment,
  jpegPhoto,
  photoFileName,
  pngCutout,
  uploadPhoto,
} from './garments';
import {
  createTestApp,
  multipart,
  recordQueries,
  TEST_PASSWORD,
  type TestApp,
} from './harness';

/**
 * What each /api/v1 route costs in statements (#190; plan section 10):
 * production pays a round trip per statement, so the count is the latency.
 * Each runs inside recordQueries, so it lands in build/statements.json as
 * `<METHOD>:/api/v1/...` and the metrics ratchet holds it. Every
 * authenticated count is the token's read (authenticateToken), as a page's
 * is the session's, plus its last-use write when the last one is a minute
 * old (pinned both ways).
 */

let t: TestApp;
let sites: LinkSites;

beforeAll(async () => {
  sites = await startLinkSites();
  t = await createTestApp({}, { outboundFetch: sites.outboundFetch });
});

afterAll(async () => {
  await t?.cleanup();
  await sites?.close();
});

async function statementsOf(work: () => Promise<{ statusCode: number }>) {
  let status = 0;
  const record = await recordQueries(async () => {
    status = (await work()).statusCode;
  });
  return { status, statements: record.statements, sql: record.sql };
}

describe('API statements per route', () => {
  it('GET /me: the token read, and its last-use write on the first call of a minute', async () => {
    await t.register('me-statements@example.com');
    const { token } = await deviceToken(t, {
      email: 'me-statements@example.com',
    });
    const me = () => t.api(token, { method: 'GET', url: '/api/v1/me' });
    const first = await statementsOf(me);
    expect(first).toMatchObject({ status: 200, statements: 2 });
    expect(first.sql[1]).toMatch(/^update "personal_access_token"/);
    expect(await statementsOf(me)).toMatchObject({
      status: 200,
      statements: 1,
    });
  });

  it('POST /auth/token: the lookup, then the mint (its twin, POST /auth/tokens, pays the same)', async () => {
    const email = 'sign-in-statements@example.com';
    const cookie = await t.register(email);
    const signIn = await statementsOf(() => signInDevice(t, { email }));
    // findUserByEmail; then createToken: begin, the user's row locked with
    // its password, the list of devices, the insert, commit.
    expect(signIn).toMatchObject({ status: 201, statements: 6 });
    // The page that mints an agent token: the session with the hash, then
    // the same transaction.
    const twin = await statementsOf(() =>
      t.inject({
        method: 'POST',
        url: '/auth/tokens',
        payload: { name: 'Twin', currentPassword: TEST_PASSWORD },
        headers: { cookie },
      }),
    );
    expect(twin).toMatchObject({ status: 200, statements: signIn.statements });
  });

  it('DELETE /auth/token: the token read and its last-use write, then the revoke', async () => {
    await t.register('sign-out-statements@example.com');
    const { token } = await deviceToken(t, {
      email: 'sign-out-statements@example.com',
    });
    expect(
      await statementsOf(() =>
        t.api(token, { method: 'DELETE', url: SIGN_IN_URL }),
      ),
    ).toMatchObject({ status: 204, statements: 3 });
  });

  describe("the wardrobe's reads: what their page twins cost (#192a)", () => {
    let ownerToken: string;
    let viewerToken: string;
    let garmentId: number;
    const shared = () => `?ownerId=${t.owner.id}`;
    /** A second call of the minute: no last-use write. */
    const warm = async (token: string, url: string) => {
      await t.api(token, { method: 'GET', url });
      return statementsOf(() => t.api(token, { method: 'GET', url }));
    };

    beforeAll(async () => {
      ownerToken = (await deviceToken(t)).token;
      const email = 'garment-statements-viewer@example.com';
      const cookie = await t.register(email);
      viewerToken = (await deviceToken(t, { email })).token;
      const invite = await t.inject({
        method: 'POST',
        url: '/wardrobe-share/create-invite-link',
        payload: { permission: 'VIEW' },
        headers: { 'hx-request': 'true' },
      });
      const code = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(
        invite.body,
      )![1];
      await t.inject({
        method: 'POST',
        url: `/wardrobe-share/invite/${code}/accept`,
        headers: { cookie },
      });
      garmentId = await createGarment(t, { name: 'Counted tee' });
    });

    it('GET /garments: the token, the page and the count, as GET /wardrobe is 3', async () => {
      expect(await warm(ownerToken, '/api/v1/garments')).toMatchObject({
        status: 200,
        statements: 3,
      });
      // A grantee's share rides in the token's read (#170).
      const grantee = await warm(viewerToken, `/api/v1/garments${shared()}`);
      expect(grantee).toMatchObject({ status: 200, statements: 3 });
      expect(grantee.sql[0]).toContain('"wardrobe_share"');
    });

    it('GET /garments/{id}: the token, the garment and its context, as its page is 3', async () => {
      const url = `/api/v1/garments/${garmentId}`;
      expect(await warm(ownerToken, url)).toMatchObject({
        status: 200,
        statements: 3,
      });
      expect(await warm(viewerToken, `${url}${shared()}`)).toMatchObject({
        status: 200,
        statements: 3,
      });
    });
  });

  describe('the garment writes: what their page twins cost (#192b)', () => {
    let token: string;

    beforeAll(async () => {
      token = (await deviceToken(t)).token;
    });

    /**
     * Each write's page twin and its API request, each on a garment of its
     * own, and how many statements the API pays beyond the page: PATCH
     * reads the garment it merges into (the form's save posts every field
     * and reads nothing); the tagging card's answer reads the garment
     * again, which the API's does not.
     */
    const CASES: {
      name: string;
      extra: number;
      ok: [page: number, api: number];
      page: (id: number) => InjectOptions;
      api: (id: number) => InjectOptions;
    }[] = [
      {
        name: 'POST /garments (POST /wardrobe)',
        extra: 0,
        ok: [302, 201],
        page: () => ({
          method: 'POST',
          url: '/wardrobe',
          payload: { name: 'Counted', category: 'tops' },
        }),
        api: () => ({
          method: 'POST',
          url: '/api/v1/garments',
          payload: { name: 'Counted', category: 'tops' },
        }),
      },
      {
        name: 'PATCH /garments/{id} (POST /wardrobe/:id)',
        extra: 1,
        ok: [302, 200],
        page: (id) => ({
          method: 'POST',
          url: `/wardrobe/${id}`,
          payload: { name: 'Renamed', category: 'tops' },
        }),
        api: (id) => ({
          method: 'PATCH',
          url: `/api/v1/garments/${id}`,
          payload: { name: 'Renamed' },
        }),
      },
      {
        name: 'DELETE /garments/{id} (DELETE /wardrobe/:id)',
        extra: 0,
        ok: [200, 204],
        page: (id) => ({ method: 'DELETE', url: `/wardrobe/${id}` }),
        api: (id) => ({ method: 'DELETE', url: `/api/v1/garments/${id}` }),
      },
      {
        name: 'PUT /garments/{id}/status (POST /wardrobe/:id/archive)',
        extra: 0,
        ok: [200, 200],
        page: (id) => ({ method: 'POST', url: `/wardrobe/${id}/archive` }),
        api: (id) => ({
          method: 'PUT',
          url: `/api/v1/garments/${id}/status`,
          payload: { status: 'archived' },
        }),
      },
      {
        name: 'PUT /garments/{id}/condition (POST /wardrobe/:id/condition)',
        extra: 0,
        ok: [303, 200],
        page: (id) => ({
          method: 'POST',
          url: `/wardrobe/${id}/condition`,
          payload: { condition: 'needs_repair' },
        }),
        api: (id) => ({
          method: 'PUT',
          url: `/api/v1/garments/${id}/condition`,
          payload: { condition: 'needs_repair' },
        }),
      },
      {
        name: 'POST /garments/{id}/clones (POST /wardrobe/:id/clone)',
        extra: 0,
        ok: [302, 201],
        page: (id) => ({
          method: 'POST',
          url: `/wardrobe/${id}/clone`,
          payload: { name: 'Twin', category: 'tops' },
        }),
        api: (id) => ({
          method: 'POST',
          url: `/api/v1/garments/${id}/clones`,
          payload: { name: 'Twin' },
        }),
      },
      {
        name: 'POST /garments/{id}/copies (POST /wardrobe/:id/copies)',
        extra: 0,
        ok: [303, 200],
        page: (id) => ({ method: 'POST', url: `/wardrobe/${id}/copies` }),
        api: (id) => ({
          method: 'POST',
          url: `/api/v1/garments/${id}/copies`,
          payload: { copies: 1 },
        }),
      },
      {
        name: 'PATCH /garments/{id}/tags (POST /wardrobe/:id/tag)',
        extra: -1,
        ok: [200, 200],
        page: (id) => ({
          method: 'POST',
          url: `/wardrobe/${id}/tag`,
          payload: { warmth: '3' },
        }),
        api: (id) => ({
          method: 'PATCH',
          url: `/api/v1/garments/${id}/tags`,
          payload: { warmth: 3 },
        }),
      },
      {
        name: 'PATCH /garments (POST /wardrobe/bulk)',
        extra: 0,
        ok: [303, 200],
        page: (id) => ({
          method: 'POST',
          url: '/wardrobe/bulk',
          payload: { ids: [id], property: 'warmth', warmth: '4' },
        }),
        api: (id) => ({
          method: 'PATCH',
          url: '/api/v1/garments',
          payload: { ids: [id], property: 'warmth', value: 4 },
        }),
      },
    ];

    it.each(CASES)('$name', async ({ extra, ok, page, api }) => {
      const [pageId, apiId] = [
        await createGarment(t, { name: 'Counted', category: 'tops' }),
        await createGarment(t, { name: 'Counted', category: 'tops' }),
      ];
      const pageRun = await statementsOf(() => t.inject(page(pageId)));
      // A second call of the minute: no last-use write.
      await t.api(token, { method: 'GET', url: '/api/v1/me' });
      const apiRun = await statementsOf(() => t.api(token, api(apiId)));
      expect([pageRun.status, apiRun.status]).toEqual(ok);
      expect(apiRun.statements).toBe(pageRun.statements + extra);
    });
  });

  describe('the photo and the repair log: what their page twins cost (#192c)', () => {
    let token: string;
    let photo: Buffer;
    let cutout: Buffer;

    beforeAll(async () => {
      token = (await deviceToken(t)).token;
      [photo, cutout] = await Promise.all([
        jpegPhoto(320, 240),
        pngCutout(320, 240),
      ]);
    });

    const file = (
      name: string,
      data: Buffer,
      filename: string,
      contentType: string,
    ) => multipart({}, { [name]: { data, filename, contentType } });

    /** A garment with a photo (`photo`), its cutout failed too (`failed`), or neither. */
    type Setup = 'bare' | 'photo' | 'failed';

    /**
     * Each write's page twin and its API request, each on a garment of its
     * own: the same domain function, so the same statements. A repair
     * entry is logged first where the write removes one.
     */
    const CASES: {
      name: string;
      setup: Setup;
      ok: [page: number, api: number];
      page: (
        id: number,
        repairId: number,
      ) => InjectOptions | Promise<InjectOptions>;
      api: (
        id: number,
        repairId: number,
      ) => InjectOptions | Promise<InjectOptions>;
    }[] = [
      {
        name: 'PUT /garments/{id}/photo (POST /wardrobe/:id/photo)',
        setup: 'bare',
        ok: [303, 200],
        page: async (id) => ({
          method: 'POST',
          url: `/wardrobe/${id}/photo`,
          ...(await file('photo', photo, 'photo.jpg', 'image/jpeg')),
        }),
        api: async (id) => ({
          method: 'PUT',
          url: `/api/v1/garments/${id}/photo`,
          ...(await file('photo', photo, 'photo.jpg', 'image/jpeg')),
        }),
      },
      {
        name: 'POST /garments/{id}/photo/rotations (POST /wardrobe/:id/photo/rotate)',
        setup: 'photo',
        ok: [303, 200],
        page: (id) => ({
          method: 'POST',
          url: `/wardrobe/${id}/photo/rotate`,
          payload: { direction: 'right' },
        }),
        api: (id) => ({
          method: 'POST',
          url: `/api/v1/garments/${id}/photo/rotations`,
          payload: { direction: 'right' },
        }),
      },
      {
        name: 'PUT /garments/{id}/photo/cutout (POST /wardrobe/:id/nobg)',
        setup: 'photo',
        ok: [200, 200],
        page: async (id) => ({
          method: 'POST',
          url: `/wardrobe/${id}/nobg`,
          ...(await file('nobgPhoto', cutout, 'cutout.png', 'image/png')),
        }),
        api: async (id) => ({
          method: 'PUT',
          url: `/api/v1/garments/${id}/photo/cutout`,
          ...(await file('cutout', cutout, 'cutout.png', 'image/png')),
        }),
      },
      {
        name: 'POST /garments/{id}/photo/cutout/retries (POST /wardrobe/:id/cutout/retry)',
        setup: 'failed',
        ok: [303, 200],
        page: (id) => ({
          method: 'POST',
          url: `/wardrobe/${id}/cutout/retry`,
        }),
        api: (id) => ({
          method: 'POST',
          url: `/api/v1/garments/${id}/photo/cutout/retries`,
        }),
      },
      {
        name: 'POST /garments/{id}/repairs (POST /wardrobe/:id/repairs)',
        setup: 'bare',
        ok: [303, 201],
        page: (id) => ({
          method: 'POST',
          url: `/wardrobe/${id}/repairs`,
          payload: { day: t.today(), kind: 'repair', note: 'Counted' },
        }),
        api: (id) => ({
          method: 'POST',
          url: `/api/v1/garments/${id}/repairs`,
          payload: { day: t.today(), kind: 'repair', note: 'Counted' },
        }),
      },
      {
        name: 'DELETE /garments/{id}/repairs/{repairId} (POST /wardrobe/:id/repairs/:repairId/delete)',
        setup: 'bare',
        ok: [303, 204],
        page: (id, repairId) => ({
          method: 'POST',
          url: `/wardrobe/${id}/repairs/${repairId}/delete`,
        }),
        api: (id, repairId) => ({
          method: 'DELETE',
          url: `/api/v1/garments/${id}/repairs/${repairId}`,
        }),
      },
    ];

    /** A garment as `setup` says, with a repair entry logged on it. */
    const garmentFor = async (setup: Setup) => {
      const id = await createGarment(t, { name: 'Counted', category: 'tops' });
      if (setup !== 'bare') await uploadPhoto(t, id, photo);
      if (setup === 'failed') await failCutout(t, await photoFileName(t, id));
      const logged = await t.api(token, {
        method: 'POST',
        url: `/api/v1/garments/${id}/repairs`,
        payload: { day: t.today(), kind: 'repair', note: 'To remove' },
      });
      return { id, repairId: logged.json<{ id: number }>().id };
    };

    it.each(CASES)('$name', async ({ setup, ok, page, api }) => {
      const [onPage, onApi] = [
        await garmentFor(setup),
        await garmentFor(setup),
      ];
      const pageRequest = await page(onPage.id, onPage.repairId);
      const pageRun = await statementsOf(() => t.inject(pageRequest));
      const apiRequest = await api(onApi.id, onApi.repairId);
      // A second call of the minute: no last-use write.
      await t.api(token, { method: 'GET', url: '/api/v1/me' });
      const apiRun = await statementsOf(() => t.api(token, apiRequest));
      expect([pageRun.status, apiRun.status]).toEqual(ok);
      expect(apiRun.statements).toBe(pageRun.statements);
    });
  });

  it('POST /garments/link-imports: the token, the pending photo kept, the claim; no read back', async () => {
    const { token } = await deviceToken(t);
    sites.serve('/counted.jpg', jpeg(await jpegPhoto(320, 240)));
    await t.api(token, { method: 'GET', url: '/api/v1/me' });
    const run = await statementsOf(() =>
      t.api(token, {
        method: 'POST',
        url: '/api/v1/garments/link-imports',
        payload: { url: sites.url('/counted.jpg'), category: 'tops' },
      }),
    );
    // The token; the fetched photo kept as a pending photo (its own
    // transaction, keepPendingPhoto); the claim (createGarmentWithPending
    // Photo: the name's lock, the pending row taken, the file row and the
    // garment). Its page twin answers the prefilled form unsaved, so no
    // count compares; its MCP twin (add_garment_from_link, 13) also reads
    // the garment back and looks for lookalikes.
    expect(run).toMatchObject({ status: 201, statements: 11 });
  });

  it('GET /openapi.json: none', async () => {
    expect(
      await statementsOf(() =>
        t.api(undefined, { method: 'GET', url: '/api/v1/openapi.json' }),
      ),
    ).toMatchObject({ status: 200, statements: 0 });
  });
});
