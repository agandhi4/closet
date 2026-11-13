import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pendingPhoto } from '../../src/db/schema';
import { t as text } from '../../src/web/i18n';
import { LINK_IMPORT_LIMIT } from '../../src/web/security/rate-limit';
import { deviceToken, expectProblem } from './api';
import { failCutout } from './cutouts';
import {
  createGarment,
  createWishlistItem,
  garmentRow,
  jpegPhoto,
  photoFileName,
  photoRowCount,
  pngCutout,
  uploadPhoto,
} from './garments';
import {
  createTestApp,
  multipart,
  type MultipartFile,
  type TestApp,
} from './harness';
import { html, jpeg, type LinkSites, startLinkSites } from './link-sites';

/**
 * A garment's photo, its repair log and the link import on /api/v1
 * (#192c), each its page twin's domain function: the upload (multipart,
 * judged before it is read), the quarter turn, the mask editor's save, the
 * cutout's retry, the repair log's two writes and the link import, which
 * saves at once and spends the page's budget. Who may do what is the
 * authorization matrix's (authorization-wardrobe.spec.ts replays its cases
 * on these twins); what each costs is api-statements'.
 */

let t: TestApp;
let sites: LinkSites;
let ownerToken: string;
let managerToken: string;
let viewerToken: string;
let photo: Buffer;

/** A multipart body of `parts`, every one a file. */
async function parts(files: Record<string, MultipartFile | MultipartFile[]>) {
  return multipart({}, files);
}

const jpegPart = (): MultipartFile => ({
  data: photo,
  filename: 'photo.jpg',
  contentType: 'image/jpeg',
});

async function putPhoto(token: string, id: number, query = '') {
  return t.api(token, {
    method: 'PUT',
    url: `/api/v1/garments/${id}/photo${query}`,
    ...(await parts({ photo: jpegPart() })),
  });
}

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
  const code = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(
    invite.body,
  )![1];
  const accepted = await t.inject({
    method: 'POST',
    url: `/wardrobe-share/invite/${code}/accept`,
    headers: { cookie },
  });
  expect(accepted.statusCode).toBe(302);
}

/** A photographed garment of the owner's whose cutout job failed. */
async function failedCutout(name: string): Promise<number> {
  const id = await createGarment(t, { name });
  await uploadPhoto(t, id, photo);
  await failCutout(t, await photoFileName(t, id));
  return id;
}

beforeAll(async () => {
  sites = await startLinkSites();
  t = await createTestApp({}, { outboundFetch: sites.outboundFetch });
  photo = await jpegPhoto(320, 240);
  ownerToken = (await deviceToken(t)).token;
  const manager = await signUp('api-photos-manager@example.com');
  managerToken = manager.token;
  await share(manager.cookie, 'MANAGE');
  const viewer = await signUp('api-photos-viewer@example.com');
  viewerToken = viewer.token;
  await share(viewer.cookie, 'VIEW');
});

afterAll(async () => {
  await t?.cleanup();
  await sites?.close();
});

describe("PUT /garments/{id}/photo: the photo sheet's upload", () => {
  it('stores the photo, queues its cutout and answers the state the garment now shows', async () => {
    const id = await createGarment(t, { name: 'Unphotographed tee' });
    const res = await putPhoto(ownerToken, id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ cutoutStatus: 'pending' });
    const read = await t.api(ownerToken, {
      method: 'GET',
      url: `/api/v1/garments/${id}`,
    });
    expect(read.json()).toMatchObject({
      photo: { cutoutStatus: 'pending' },
    });
    // A second upload replaces the first: one row, the new name.
    const first = await photoFileName(t, id);
    expect((await putPhoto(ownerToken, id)).statusCode).toBe(200);
    expect(await photoFileName(t, id)).not.toBe(first);
  });

  it("takes a MANAGE grantee's upload into the owner's wardrobe, refuses a VIEW grantee's before reading it", async () => {
    const id = await createGarment(t, { name: 'Shared upload tee' });
    const shared = `?ownerId=${t.owner.id}`;
    expect((await putPhoto(managerToken, id, shared)).statusCode).toBe(200);
    const row = await garmentRow(t, id);
    expect(row?.photo?.createdById).toBe(t.owner.id);
    const files = await photoRowCount(t);
    expectProblem(await putPhoto(viewerToken, id, shared), 403, 'forbidden');
    expect(await photoRowCount(t)).toBe(files);
  });

  it('refuses a second file, no photo part and an image it cannot read, storing nothing', async () => {
    const id = await createGarment(t, { name: 'Refused upload tee' });
    const files = await photoRowCount(t);
    const two = await t.api(ownerToken, {
      method: 'PUT',
      url: `/api/v1/garments/${id}/photo`,
      ...(await parts({ photo: [jpegPart(), jpegPart()] })),
    });
    expectProblem(two, 413, 'validation');
    const none = await t.api(ownerToken, {
      method: 'PUT',
      url: `/api/v1/garments/${id}/photo`,
      ...(await parts({ other: jpegPart() })),
    });
    expectProblem(none, 400, 'validation');
    const unreadable = await t.api(ownerToken, {
      method: 'PUT',
      url: `/api/v1/garments/${id}/photo`,
      ...(await parts({
        photo: {
          data: Buffer.from('not an image'),
          filename: 'photo.jpg',
          contentType: 'image/jpeg',
        },
      })),
    });
    expectProblem(unreadable, 400, 'validation');
    expect(await photoRowCount(t)).toBe(files);
    expect((await garmentRow(t, id))?.photo).toBeNull();
  });
});

describe('the photo after it is stored', () => {
  it('turns it a quarter as a new photo; a garment without one is a 400', async () => {
    const id = await createGarment(t, { name: 'Turned tee' });
    await uploadPhoto(t, id, photo);
    const before = await photoFileName(t, id);
    const turn = (garmentId: number) =>
      t.api(ownerToken, {
        method: 'POST',
        url: `/api/v1/garments/${garmentId}/photo/rotations`,
        payload: { direction: 'left' },
      });
    const res = await turn(id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ cutoutStatus: 'pending' });
    expect(await photoFileName(t, id)).not.toBe(before);
    const bare = await createGarment(t, { name: 'Bare tee' });
    expectProblem(await turn(bare), 400, 'validation');
  });

  it("saves an edited cutout and answers the photo's new URLs", async () => {
    const id = await createGarment(t, { name: 'Masked tee' });
    await uploadPhoto(t, id, photo);
    const res = await t.api(ownerToken, {
      method: 'PUT',
      url: `/api/v1/garments/${id}/photo/cutout`,
      ...(await parts({
        cutout: {
          data: await pngCutout(320, 240),
          filename: 'cutout.png',
          contentType: 'image/png',
        },
      })),
    });
    expect(res.statusCode, res.body).toBe(200);
    const answer = res.json<Record<string, unknown>>();
    expect(answer).toMatchObject({ cutoutStatus: 'edited', version: 2 });
    // The new set's: keyed, at the new version.
    expect(answer.cutoutUrl).toMatch(/\?v=2&k=[0-9a-f]{12}&s=/);
    // What the garment now reads.
    const read = await t.api(ownerToken, {
      method: 'GET',
      url: `/api/v1/garments/${id}`,
    });
    expect(read.json<{ photo: unknown }>().photo).toEqual(answer);
    const empty = await t.api(ownerToken, {
      method: 'PUT',
      url: `/api/v1/garments/${id}/photo/cutout`,
      ...(await multipart({ note: 'no file' }, {})),
    });
    expectProblem(empty, 400, 'validation');
  });

  it('queues a failed cutout again, once: a second retry is answered, not repeated', async () => {
    const id = await failedCutout('Retried tee');
    const retry = () =>
      t.api(ownerToken, {
        method: 'POST',
        url: `/api/v1/garments/${id}/photo/cutout/retries`,
      });
    const first = await retry();
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toEqual({ requeued: true });
    expect((await garmentRow(t, id))?.photo?.cutoutStatus).toBe('pending');
    expect((await retry()).json()).toEqual({ requeued: false });
  });
});

describe('the repair log (the owner only)', () => {
  const log = (token: string, id: number, entry: object, query = '') =>
    t.api(token, {
      method: 'POST',
      url: `/api/v1/garments/${id}/repairs${query}`,
      payload: entry,
    });

  it('logs an entry the garment then reads, and removes it; a removed one is a 404', async () => {
    const id = await createGarment(t, { name: 'Mended coat' });
    const res = await log(ownerToken, id, {
      day: t.today(),
      kind: 'repair',
      note: 'New buttons',
      cost: '12.50',
    });
    expect(res.statusCode, res.body).toBe(201);
    const { id: repairId } = res.json<{ id: number }>();
    const read = await t.api(ownerToken, {
      method: 'GET',
      url: `/api/v1/garments/${id}`,
    });
    expect(read.json()).toMatchObject({
      repairs: [
        {
          id: repairId,
          day: t.today(),
          kind: 'repair',
          note: 'New buttons',
          cost: '12.50',
        },
      ],
    });
    const remove = () =>
      t.api(ownerToken, {
        method: 'DELETE',
        url: `/api/v1/garments/${id}/repairs/${repairId}`,
      });
    expect((await remove()).statusCode).toBe(204);
    expectProblem(await remove(), 404, 'not_found');
  });

  it("refuses a day after today naming the field, a wishlist item, and a MANAGE grantee's entry", async () => {
    const id = await createGarment(t, { name: 'Future coat' });
    const future = expectProblem(
      await log(ownerToken, id, {
        day: '2999-01-01',
        kind: 'alteration',
        note: 'Hemmed',
      }),
      400,
      'validation',
    );
    expect(future.errors).toEqual([
      { path: 'body/day', message: text('validation.REPAIR_DAY_FUTURE') },
    ]);
    const wish = await createWishlistItem(t, { name: 'Wished coat' });
    expectProblem(
      await log(ownerToken, wish, {
        day: t.today(),
        kind: 'repair',
        note: 'Too early',
      }),
      409,
      'conflict',
    );
    expectProblem(
      await log(
        managerToken,
        id,
        { day: t.today(), kind: 'repair', note: 'Not mine' },
        `?ownerId=${t.owner.id}`,
      ),
      403,
      'forbidden',
    );
  });
});

describe('POST /garments/link-imports', () => {
  const PAGE = `<!doctype html><html><head>
<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'Linen Camp Shirt',
    brand: { '@type': 'Brand', name: 'Field Day' },
    category: 'Shirts',
    image: ['/api-shirt.jpg'],
    offers: { '@type': 'Offer', price: '64.00', priceCurrency: 'USD' },
  })}</script></head><body></body></html>`;

  const importLink = (token: string, body: object, query = '') =>
    t.api(token, {
      method: 'POST',
      url: `/api/v1/garments/link-imports${query}`,
      payload: body,
    });

  beforeAll(() => {
    sites.serve('/api-shirt', html(PAGE));
    sites.serve('/api-shirt.jpg', jpeg(photo));
  });

  it('saves the garment the page describes, with its photo queued, into the wardrobe addressed', async () => {
    const res = await importLink(
      managerToken,
      { url: `Look: ${sites.url('/api-shirt')}`, size: 'M' },
      `?ownerId=${t.owner.id}`,
    );
    expect(res.statusCode, res.body).toBe(201);
    const { id, notices } = res.json<{ id: number; notices: string[] }>();
    expect(res.headers.location).toBe(
      `/api/v1/garments/${id}?ownerId=${t.owner.id}`,
    );
    expect(notices).toContain(text('linkImport.FOUND_DETAILS'));
    const row = await garmentRow(t, id);
    expect(row).toMatchObject({
      ownerId: t.owner.id,
      name: 'Linen Camp Shirt',
      brand: 'Field Day',
      // The form's own size rules (a letter size spelled out).
      size: 'Medium',
      price: '64.00',
      status: 'closet',
      photo: { cutoutStatus: 'pending', createdById: t.owner.id },
    });
  });

  it('refuses text without a link, a replaced garment off the wishlist, and a form it cannot save', async () => {
    const noLink = expectProblem(
      await importLink(ownerToken, { url: 'no link here' }),
      400,
      'validation',
    );
    expect(noLink.errors).toEqual([
      { path: 'body/url', message: text('linkImport.NO_LINK') },
    ]);
    expectProblem(
      await importLink(ownerToken, {
        url: sites.url('/api-shirt'),
        replacesGarmentId: 1,
      }),
      400,
      'validation',
    );
    // An image link names no category; the photo it fetched goes with the
    // refusal, and no garment or `file` row was written.
    const files = await photoRowCount(t);
    const bare = expectProblem(
      await importLink(ownerToken, { url: sites.url('/api-shirt.jpg') }),
      400,
      'validation',
    );
    expect(bare.errors?.map(({ path }) => path)).toEqual(['body/category']);
    expect(await photoRowCount(t)).toBe(files);
    expect(await t.db.$count(pendingPhoto)).toBe(0);
  });

  it('refuses a bad body before the budget, so it spends none', async () => {
    const { token } = await signUp('api-photos-cheap@example.com');
    for (let i = 0; i < LINK_IMPORT_LIMIT.max + 2; i++) {
      expect(
        (await importLink(token, { url: 'no link here' })).statusCode,
      ).toBe(400);
    }
    const res = await importLink(token, {
      url: sites.url('/api-shirt'),
      replacesGarmentId: 1,
    });
    expect(res.statusCode).toBe(400);
  });

  it("spends the page's budget: ten between the two doors, then a 429 at either", async () => {
    const { cookie, token } = await signUp('api-photos-importer@example.com');
    const page = () =>
      t.inject({
        method: 'POST',
        url: '/wardrobe/new/from-link',
        payload: { url: 'no link here' },
        headers: { cookie },
      });
    // A link the site does not serve: refused after the fetch, so it spends.
    const api = () => importLink(token, { url: sites.url('/api-missing') });
    for (let i = 0; i < 5; i++) {
      expect((await page()).statusCode).toBe(400);
      expect((await api()).statusCode).toBeGreaterThanOrEqual(400);
    }
    const refused = await api();
    expectProblem(refused, 429, 'rate_limited');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect((await page()).statusCode).toBe(429);
  });
});
