import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garment, inspirationPiece } from '../../src/db/schema';
import { t as text } from '../../src/web/i18n';
import { deviceToken, expectProblem } from './api';
import { jpegPhoto } from './garments';
import { createTestApp, multipart, type TestApp } from './harness';
import {
  html,
  INTRANET_HOST,
  jpeg,
  type LinkSites,
  startLinkSites,
} from './link-sites';

/**
 * Saved looks on /api/v1 (#193d): each its page twin's writer (writes.ts,
 * queries.ts, saveRecreation, addPieceToWishlist) and the match view's
 * read (recreateOwnLook). Who may do what is the authorization matrix's
 * (authorization-outfits.spec.ts replays the pages' cases on these twins);
 * what each costs is api-statements'; the matching itself is
 * recreate.spec.ts'.
 */

interface LookPhoto {
  version: number;
  originalUrl: string;
  thumbUrl: string;
}

interface Piece {
  position: number;
  role: string;
  type?: string;
  colors: string[];
  pattern?: string;
  matched?: { garmentId: number; status: string };
}

interface Look {
  id: number;
  title?: string;
  note?: string;
  sourceUrl?: string;
  photo?: LookPhoto;
  pieces: Piece[];
}

interface Recreation extends Omit<Look, 'pieces'> {
  pieces: (Piece & {
    matches: { garment: { id: number }; available: boolean }[];
    missing: boolean;
    repicked: boolean;
  })[];
  unfixedPositions: number[];
}

let t: TestApp;
let sites: LinkSites;
let token: string;
let strangerToken: string;
let photo: Buffer;

const api = (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
  as = token,
) => t.api(as, { method, url: `/api/v1${url}`, payload });

/** A look from a photo, through POST /looks; `fields` are its text parts. */
async function createLook(fields: Record<string, string> = {}, as = token) {
  const body = await multipart(fields, {
    photo: { data: photo, filename: 'look.jpg', contentType: 'image/jpeg' },
  });
  return t.api(as, { method: 'POST', url: '/api/v1/looks', ...body });
}

async function newLook(fields: Record<string, string> = {}): Promise<number> {
  const res = await createLook(fields);
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: number }>().id;
}

const getLook = async (id: number) =>
  (await api('GET', `/looks/${id}`)).json<Look>();

/** A closet top of `type` and `color`, through the garment form. */
async function closetTop(name: string, type: string, color: string) {
  const res = await t.inject({
    method: 'POST',
    url: '/wardrobe',
    payload: { name, category: 'tops', props: '1', type, color: [color] },
  });
  expect(res.statusCode).toBe(302);
  return Number(/^\/wardrobe\/(\d+)\?/.exec(String(res.headers.location))![1]);
}

const storedWebp = async () =>
  (await readdir(t.dataPath)).filter((name) => name.endsWith('.webp'));

beforeAll(async () => {
  sites = await startLinkSites();
  t = await createTestApp({}, { outboundFetch: sites.outboundFetch });
  photo = await jpegPhoto(600, 800);
  sites.serve('/look.jpg', jpeg(photo));
  sites.serve(
    '/lookbook',
    html(
      `<html><head><title>Linen and loafers</title><meta property="og:image" content="${sites.url('/look.jpg')}"></head><body></body></html>`,
    ),
  );
  sites.serve('/blocked', {
    status: 403,
    type: 'text/html',
    body: '<title>Just a moment...</title>',
    headers: { 'cf-mitigated': 'challenge' },
  });
  token = (await deviceToken(t)).token;
  const email = 'api-looks-stranger@example.com';
  await t.register(email);
  strangerToken = (await deviceToken(t, { email })).token;
});

afterAll(async () => {
  await t?.cleanup();
  await sites?.close();
});

describe('looks', () => {
  it('saves one from a photo with its link and title, serves its photo to the owner alone, and pages the list', async () => {
    const created = await createLook({
      url: 'https://example.com/street-style',
      title: 'Street style',
      clientId: randomUUID(),
    });
    expect(created.statusCode, created.body).toBe(201);
    const { id, photo: made } = created.json<{
      id: number;
      photo: LookPhoto;
    }>();
    expect(created.headers.location).toBe(`/api/v1/looks/${id}`);
    expect(await getLook(id)).toEqual({
      id,
      title: 'Street style',
      sourceUrl: 'https://example.com/street-style',
      photo: made,
      pieces: [],
    });

    // The photo's two URLs, to the owner's token only.
    for (const url of [made.originalUrl, made.thumbUrl]) {
      const bytes = await t.api(token, { method: 'GET', url });
      expect(bytes.statusCode, url).toBe(200);
      expect(bytes.headers['content-type']).toBe('image/webp');
      expect(bytes.headers['cache-control']).toBe(
        'private, max-age=31536000, immutable',
      );
      const refused = expectProblem(
        await t.api(strangerToken, { method: 'GET', url }),
        404,
        'not_found',
      );
      expect(JSON.stringify(refused)).not.toContain(
        made.originalUrl.split('/').pop()!.split('?')[0],
      );
    }
    expectProblem(
      await api('GET', '/look-photos/not-a-photo.webp'),
      404,
      'not_found',
    );

    const older = await newLook();
    const first = await api('GET', '/looks?limit=1');
    const page1 = first.json<{
      data: { id: number; pieceCount: number }[];
      pagination: { nextCursor?: string };
    }>();
    expect(page1.data).toEqual([expect.objectContaining({ id: older })]);
    const page2 = (
      await api('GET', `/looks?limit=1&cursor=${page1.pagination.nextCursor!}`)
    ).json<{ data: { id: number; pieceCount: number }[] }>();
    expect(page2.data).toEqual([
      expect.objectContaining({ id, pieceCount: 0, title: 'Street style' }),
    ]);
    expect(
      (await api('GET', '/looks', undefined, strangerToken)).json<{
        data: unknown[];
      }>().data,
    ).toEqual([]);
  });

  it('refuses a text part it cannot store, keeping none of the photo', async () => {
    const before = await storedWebp();
    expectProblem(
      await createLook({ clientId: 'not-a-uuid' }),
      400,
      'validation',
    );
    expectProblem(await createLook({ url: 'ftp://x/y' }), 400, 'validation');
    expect(await storedWebp()).toEqual(before);
  });

  it('saves one from a link: the page read, a blocked site kept with why, a private address refused', async () => {
    const saved = await api('POST', '/looks/link-imports', {
      url: `see ${sites.url('/lookbook')}`,
      clientId: randomUUID(),
    });
    expect(saved.statusCode, saved.body).toBe(201);
    const { id } = saved.json<{ id: number; unread?: string }>();
    expect(saved.json()).toEqual({ id });
    expect(await getLook(id)).toMatchObject({
      title: 'Linen and loafers',
      sourceUrl: sites.url('/lookbook'),
      photo: expect.any(Object),
    });

    const blocked = await api('POST', '/looks/link-imports', {
      url: sites.url('/blocked'),
    });
    expect(blocked.statusCode).toBe(201);
    expect(blocked.json()).toMatchObject({ unread: 'blocked-by-site' });
    expect(await getLook(blocked.json<{ id: number }>().id)).not.toHaveProperty(
      'photo',
    );

    const privateAddress = expectProblem(
      await api('POST', '/looks/link-imports', {
        url: `http://${INTRANET_HOST}/look`,
      }),
      400,
      'validation',
    );
    expect(privateAddress.detail).toBe(
      `blocked-address: ${text('linkImport.BLOCKED_ADDRESS')}`,
    );
    expect(
      expectProblem(
        await api('POST', '/looks/link-imports', { url: 'no link here' }),
        400,
        'validation',
      ).errors,
    ).toEqual([expect.objectContaining({ path: 'body/url' })]);
  });

  it('changes the title or the note alone, a blank clearing it; another’s look is a 404', async () => {
    const id = await newLook({ title: 'Before' });
    const patch = (body: object, as = token) =>
      api('PATCH', `/looks/${id}`, body, as);
    expect((await patch({ note: '  Wide trousers  ' })).statusCode).toBe(204);
    expect(await getLook(id)).toMatchObject({
      title: 'Before',
      note: 'Wide trousers',
    });
    expect((await patch({ title: ' ', note: null })).statusCode).toBe(204);
    const cleared = await getLook(id);
    expect(cleared).not.toHaveProperty('title');
    expect(cleared).not.toHaveProperty('note');
    expectProblem(await patch({}), 400, 'validation');
    // Never coerced: a number is no title.
    expectProblem(await patch({ title: 3 }), 400, 'validation');
    expectProblem(
      await patch({ title: 'Mine' }, strangerToken),
      404,
      'not_found',
    );
  });

  it('replaces the photo, the old one gone; deletes the look with its photo', async () => {
    const id = await newLook();
    const old = (await getLook(id)).photo!;
    const body = await multipart(
      {},
      { photo: { data: photo, filename: 'b.jpg', contentType: 'image/jpeg' } },
    );
    const replaced = await t.api(token, {
      method: 'PUT',
      url: `/api/v1/looks/${id}/photo`,
      ...body,
    });
    expect(replaced.statusCode, replaced.body).toBe(200);
    const answer = replaced.json<{ photo: LookPhoto; replaced: boolean }>();
    expect(answer.replaced).toBe(true);
    expect((await getLook(id)).photo).toEqual(answer.photo);
    expectProblem(
      await t.api(token, { method: 'GET', url: old.originalUrl }),
      404,
      'not_found',
    );

    expect((await api('DELETE', `/looks/${id}`)).statusCode).toBe(204);
    expectProblem(await api('GET', `/looks/${id}`), 404, 'not_found');
    expectProblem(
      await t.api(token, { method: 'GET', url: answer.photo.originalUrl }),
      404,
      'not_found',
    );
    expectProblem(await api('DELETE', `/looks/${id}`), 404, 'not_found');
  });
});

describe('pieces', () => {
  it('adds at positions never reused, replaces one whole, refuses a type of another role and a removed piece', async () => {
    const id = await newLook();
    const add = (body: object) => api('POST', `/looks/${id}/pieces`, body);
    const first = await add({
      role: 'top',
      type: 't-shirt',
      colors: ['white'],
    });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toEqual({
      position: 0,
      role: 'top',
      type: 't-shirt',
      colors: ['white'],
    });
    expect((await api('DELETE', `/looks/${id}/pieces/0`)).statusCode).toBe(204);
    // The counter only grows: a removed piece's position stays retired.
    const second = await add({ role: 'bottom', colors: ['blue', 'blue'] });
    expect(second.json()).toEqual({
      position: 1,
      role: 'bottom',
      colors: ['blue'],
    });
    expectProblem(
      await api('PUT', `/looks/${id}/pieces/0`, { role: 'top' }),
      404,
      'not_found',
    );

    const wrongType = expectProblem(
      await add({ role: 'bottom', type: 't-shirt' }),
      400,
      'validation',
    );
    expect(wrongType.errors).toEqual([
      expect.objectContaining({ path: 'body/type' }),
    ]);
    const saved = await api('PUT', `/looks/${id}/pieces/1`, {
      role: 'bottom',
      type: 'jeans',
      pattern: 'solid',
    });
    expect(saved.json()).toEqual({
      position: 1,
      role: 'bottom',
      type: 'jeans',
      colors: [],
      pattern: 'solid',
    });
    expect((await getLook(id)).pieces).toEqual([saved.json()]);
  });

  it('sets the whole list as MCP does; another’s look is a 404', async () => {
    const id = await newLook();
    const set = (pieces: object[], as = token) =>
      api('PUT', `/looks/${id}/pieces`, { pieces }, as);
    const tee = { role: 'top', type: 't-shirt', colors: ['white'] };
    const jeans = { role: 'bottom', type: 'jeans', colors: ['blue'] };
    expect((await set([tee, jeans])).json()).toEqual({
      kept: 0,
      removed: 0,
      added: 2,
    });
    // The same list again changes nothing; a new one keeps what it shares.
    expect((await set([tee, jeans])).json()).toEqual({
      kept: 2,
      removed: 0,
      added: 0,
    });
    const coat = { role: 'layer', colors: ['beige'] };
    expect((await set([jeans, coat])).json()).toEqual({
      kept: 1,
      removed: 1,
      added: 1,
    });
    expect((await getLook(id)).pieces.map((p) => p.position)).toEqual([1, 2]);
    const refused = expectProblem(
      await set([jeans, { role: 'layer', type: 'jeans' }]),
      400,
      'validation',
    );
    expect(refused.errors).toEqual([
      expect.objectContaining({ path: 'body/pieces/1/type' }),
    ]);
    expectProblem(await set([tee], strangerToken), 404, 'not_found');
    expect((await getLook(id)).pieces).toHaveLength(2);
  });
});

describe('recreating a look', () => {
  it('matches the pieces, saves the choice as an outfit once, and refuses a stale position', async () => {
    const tee = await closetTop('Recreate tee', 't-shirt', 'white');
    const id = await newLook({ title: 'Weekend' });
    await api('PUT', `/looks/${id}/pieces`, {
      pieces: [
        { role: 'top', type: 't-shirt', colors: ['white'] },
        { role: 'bottom', type: 'chinos', colors: ['green'] },
      ],
    });
    const read = await api('GET', `/looks/${id}/recreation`);
    expect(read.statusCode, read.body).toBe(200);
    const recreation = read.json<Recreation>();
    expect(recreation).toMatchObject({
      id,
      title: 'Weekend',
      unfixedPositions: [],
    });
    const [top, bottom] = recreation.pieces;
    expect(top).toMatchObject({ position: 0, missing: false, repicked: false });
    expect(top.matches[0]).toMatchObject({
      garment: { id: tee },
      available: true,
      agrees: { type: true, color: 'exact' },
    });
    expect(bottom).toMatchObject({ position: 1, missing: true, matches: [] });

    const choose = (choices: object[]) =>
      api('POST', `/looks/${id}/outfits`, { choices });
    const saved = await choose([
      { position: 0, garmentId: tee },
      { position: 1, garmentId: null },
    ]);
    expect(saved.statusCode, saved.body).toBe(201);
    const outfitId = saved.json<{ id: number }>().id;
    expect(saved.headers.location).toBe(`/api/v1/outfits/${outfitId}`);
    // A retry is the same outfit.
    const again = await choose([{ position: 0, garmentId: tee }]);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ id: outfitId, alreadySaved: true });
    expect((await getLook(id)).pieces[0].matched).toMatchObject({
      garmentId: tee,
      status: 'closet',
    });

    expectProblem(
      await choose([{ position: 7, garmentId: tee }]),
      409,
      'conflict',
    );
    expectProblem(await choose([{ position: 1 }]), 400, 'validation');
    expectProblem(
      await choose([
        { position: 0, garmentId: tee },
        { position: 0, garmentId: tee },
      ]),
      400,
      'validation',
    );
    expectProblem(
      await api('GET', `/looks/${id}/recreation`, undefined, strangerToken),
      404,
      'not_found',
    );
  });

  it('puts a missing piece on the wishlist once; the recreation then names it', async () => {
    const id = await newLook({ title: 'Office' });
    await api('POST', `/looks/${id}/pieces`, {
      role: 'layer',
      type: 'blazer',
      colors: ['blue'],
    });
    const find = () => api('PUT', `/looks/${id}/pieces/0/wishlist-item`);
    const found = await find();
    expect(found.statusCode, found.body).toBe(201);
    const { garmentId } = found.json<{ garmentId: number }>();
    expect(found.headers.location).toBe(`/api/v1/garments/${garmentId}`);
    expect((await find()).json()).toEqual({ garmentId, created: false });
    const [item] = await t.db
      .select({ status: garment.status, type: garment.type })
      .from(garment)
      .where(eq(garment.id, garmentId));
    expect(item).toEqual({ status: 'wishlist', type: 'blazer' });
    const [piece] = (
      await api('GET', `/looks/${id}/recreation`)
    ).json<Recreation>().pieces;
    expect(piece).toMatchObject({
      matched: { garmentId, status: 'wishlist' },
      missing: false,
      matches: [],
    });
    expectProblem(
      await api(
        'PUT',
        `/looks/${id}/pieces/0/wishlist-item`,
        undefined,
        strangerToken,
      ),
      404,
      'not_found',
    );
    const [row] = await t.db
      .select({ matched: inspirationPiece.matchedGarmentId })
      .from(inspirationPiece)
      .where(eq(inspirationPiece.inspirationId, id));
    expect(row.matched).toBe(garmentId);
  });
});
