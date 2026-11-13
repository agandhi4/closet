import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deviceToken, expectProblem } from './api';
import { createGarment, jpegPhoto, uploadPhoto } from './garments';
import { createTestApp, type TestApp } from './harness';

/**
 * The wardrobe's reads on /api/v1 (#192a): GET /garments (the grid's
 * filters, keyset paging behind an opaque cursor) and GET /garments/{id}
 * (the garment in full, its signed photo URLs, the owner's records only
 * for the owner). Who may read what is the authorization matrix's (its
 * GET /wardrobe and GET /wardrobe/:id cases replay on these twins,
 * authorization-wardrobe.spec.ts); what each costs is api-statements'.
 */

let t: TestApp;
let ownerToken: string;
let viewerToken: string;
let strangerToken: string;
/** The owner's garments, newest first. */
let ids: number[];
let photographed: number;

interface ListAnswer {
  data: { id: number; name?: string; category: string; photo?: unknown }[];
  pagination: { nextCursor?: string; limit: number };
  total: number;
}

const list = (token: string, query = '') =>
  t.api(token, { method: 'GET', url: `/api/v1/garments${query}` });

const get = (token: string, id: number, query = '') =>
  t.api(token, { method: 'GET', url: `/api/v1/garments/${id}${query}` });

async function signUp(
  email: string,
): Promise<{ cookie: string; token: string }> {
  const cookie = await t.register(email);
  return { cookie, token: (await deviceToken(t, { email })).token };
}

/** The owner's invite, accepted by `cookie`'s account. */
async function share(cookie: string, permission: 'VIEW' | 'MANAGE') {
  const invite = await t.inject({
    method: 'POST',
    url: '/wardrobe-share/create-invite-link',
    payload: { permission },
    headers: { 'hx-request': 'true' },
  });
  const token = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(
    invite.body,
  )![1];
  const accepted = await t.inject({
    method: 'POST',
    url: `/wardrobe-share/invite/${token}/accept`,
    headers: { cookie },
  });
  expect(accepted.statusCode).toBe(302);
}

beforeAll(async () => {
  t = await createTestApp();
  ownerToken = (await deviceToken(t)).token;
  const viewer = await signUp('api-garments-viewer@example.com');
  viewerToken = viewer.token;
  await share(viewer.cookie, 'VIEW');
  strangerToken = (await signUp('api-garments-stranger@example.com')).token;
  const created: number[] = [];
  for (const [index, category] of [
    'shirt',
    'pants',
    'shirt',
    'pants',
    'shirt',
  ].entries()) {
    created.push(
      await createGarment(t, { name: `Api garment ${index}`, category }),
    );
  }
  ids = created.reverse();
  photographed = ids[0];
  await uploadPhoto(t, photographed, await jpegPhoto(320, 240));
});

afterAll(() => t?.cleanup());

describe('GET /api/v1/garments', () => {
  it('pages the closet newest first behind an opaque cursor, with the total', async () => {
    const first = await list(ownerToken, '?limit=2');
    expect(first.statusCode, first.body).toBe(200);
    const page = first.json<ListAnswer>();
    expect(page.data.map(({ id }) => id)).toEqual(ids.slice(0, 2));
    expect(page.total).toBe(ids.length);
    expect(page.pagination.limit).toBe(2);
    const cursor = page.pagination.nextCursor!;
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain(String(ids[1]));

    const second = await list(ownerToken, `?limit=2&cursor=${cursor}`);
    expect(second.json<ListAnswer>().data.map(({ id }) => id)).toEqual(
      ids.slice(2, 4),
    );
    const last = await list(
      ownerToken,
      `?limit=2&cursor=${second.json<ListAnswer>().pagination.nextCursor}`,
    );
    expect(last.json<ListAnswer>().data.map(({ id }) => id)).toEqual(
      ids.slice(4),
    );
    expect(last.json<ListAnswer>().pagination).toEqual({ limit: 2 });
  });

  it('keeps a cursor stable: a garment added since shifts nothing onto its page', async () => {
    const first = (await list(ownerToken, '?limit=2')).json<ListAnswer>();
    const cursor = first.pagination.nextCursor!;
    const page = async () => {
      const { data, pagination } = (
        await list(ownerToken, `?limit=2&cursor=${cursor}`)
      ).json<ListAnswer>();
      return { data, pagination };
    };
    const before = await page();
    const added = await createGarment(t, { name: 'Api garment later' });
    try {
      // Only the total counts the new one.
      expect(await page()).toEqual(before);
    } finally {
      await t.inject({ method: 'DELETE', url: `/wardrobe/${added}` });
    }
  });

  it("filters as the grid does, and draws each tile's photo", async () => {
    const res = await list(ownerToken, '?category=shirt&limit=100');
    const page = res.json<ListAnswer>();
    expect(page.total).toBe(3);
    expect(page.data.every(({ category }) => category === 'shirt')).toBe(true);
    expect(
      page.data.find(({ id }) => id === photographed)?.photo,
    ).toMatchObject({
      thumbUrl: expect.stringMatching(/^\/file\/thumb\/[^?]+\?v=\d+.*&s=/),
    });
    // A garment without a photo has no `photo`, never a null.
    expect(page.data.find(({ id }) => id !== photographed)).not.toHaveProperty(
      'photo',
    );
  });

  it('refuses a type without its category, a forged cursor and a limit past 100', async () => {
    expectProblem(await list(ownerToken, '?type=t-shirt'), 400, 'validation');
    const forged = Buffer.from('before:1').toString('base64url');
    expectProblem(
      await list(ownerToken, `?cursor=${forged}`),
      400,
      'validation',
    );
    expectProblem(await list(ownerToken, '?limit=101'), 400, 'validation');
  });

  it("serves a grantee the owner's closet, without what reads the owner's wears", async () => {
    const owner = `?ownerId=${t.owner.id}`;
    const shared = await list(viewerToken, owner);
    expect(shared.statusCode).toBe(200);
    expect(shared.json<ListAnswer>().total).toBe(ids.length);
    const wash = expectProblem(
      await list(viewerToken, `${owner}&needsWash=true`),
      403,
      'forbidden',
    );
    expect(wash.detail).toBe('needsWash reads your own wears only');
    // The grantee's own wardrobe holds none of the owner's garments.
    expect((await list(viewerToken)).json<ListAnswer>().total).toBe(0);
  });

  it("answers a stranger's ?ownerId= with the problem 404 of an unknown wardrobe", async () => {
    const problem = expectProblem(
      await list(strangerToken, `?ownerId=${t.owner.id}`),
      404,
      'not_found',
    );
    expect(problem.detail).toBe('Wardrobe not found');
    expect(problem.detail).not.toContain(String(t.owner.id));
  });
});

describe('GET /api/v1/garments/{id}', () => {
  it("answers the owner the garment in full, the owner's records and signed photo URLs", async () => {
    const res = await get(ownerToken, photographed);
    expect(res.statusCode, res.body).toBe(200);
    const garment = res.json<Record<string, unknown>>();
    expect(garment).toMatchObject({
      id: photographed,
      name: 'Api garment 4',
      category: 'shirt',
      status: 'closet',
      colors: [],
      quantity: 1,
      condition: 'good',
      capsules: [],
      care: { worn: 0, wornSinceWash: 0 },
      repairs: [],
    });
    // Nulls are left out, never sent as null or "".
    expect(garment).not.toHaveProperty('brand');
    expect(JSON.stringify(garment)).not.toContain('null');
    const photo = garment.photo as Record<string, string>;
    expect(photo.originalUrl).toMatch(/^\/file\/[^/?]+\?v=\d+.*&s=/);
    const thumb = await t.inject({
      method: 'GET',
      url: photo.thumbUrl,
      anonymous: true,
    });
    expect(thumb.statusCode).toBe(200);
    expect(thumb.headers['content-type']).toBe('image/webp');
  });

  it("answers a VIEW grantee the garment without the owner's records", async () => {
    const res = await get(viewerToken, photographed, `?ownerId=${t.owner.id}`);
    expect(res.statusCode).toBe(200);
    const garment = res.json<Record<string, unknown>>();
    expect(garment).toMatchObject({ id: photographed, name: 'Api garment 4' });
    expect(garment).not.toHaveProperty('care');
    expect(garment).not.toHaveProperty('repairs');
  });

  it('answers a stranger, and a grantee outside the share, the problem 404 of an unknown garment', async () => {
    for (const [token, query] of [
      [strangerToken, `?ownerId=${t.owner.id}`],
      [strangerToken, ''],
      [viewerToken, ''],
    ] as const) {
      const problem = expectProblem(
        await get(token, photographed, query),
        404,
        'not_found',
      );
      expect(problem.detail).toBe('Garment not found');
      expect(JSON.stringify(problem)).not.toContain('Api garment');
    }
  });
});
