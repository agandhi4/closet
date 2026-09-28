import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { variantFileName } from '../../src/web/files/image-variant';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import {
  createGarment,
  jpegPhoto,
  photoFileName,
  photoRow,
  pngCutout,
  uploadPhoto,
} from './garments';
import { variantPath } from './cutouts';
import {
  createTestApp,
  multipart,
  recordQueries,
  TestApp,
  unescapeHtml,
} from './harness';

/**
 * /file/** serves photos from DATA_PATH without a session, and DATA_PATH also
 * holds app.log. Until 2026-09-25 the route accepted any "safe-looking" name,
 * so /file/app.log served the request log, session cookies included, to
 * anyone on the public hostname. Two independent guards now: the route takes
 * only photo base names, and the logger never writes a credential.
 */
describe('/file route and request logging', () => {
  let t: TestApp;
  let photoName: string;

  beforeAll(async () => {
    // The real outputs: the assertions below read app.log.
    t = await createTestApp({ LOG_LEVEL: 'info' }, { appLog: true });
    const garmentId = await createGarment(t, { name: 'Wool coat' });
    await uploadPhoto(t, garmentId, await jpegPhoto());
    photoName = await photoFileName(t, garmentId);
  });

  afterAll(() => t?.cleanup());

  const status = async (url: string) =>
    (await t.inject({ method: 'GET', url })).statusCode;

  it('serves a photo and its variants by base name', async () => {
    expect(await status(`/file/${photoName}?v=1`)).toBe(200);
    expect(await status(`/file/thumb/${photoName}?v=1`)).toBe(200);
    expect(await status(`/file/nobg/${photoName}?v=1`)).toBe(200);
  });

  // `private` (#229): no shared cache may keep a user's photo, while the
  // browser keeps it immutable for a year (the #162 caching model).
  it('serves every variant as private, immutable WebP for a year', async () => {
    for (const prefix of ['/file', '/file/nobg', '/file/thumb']) {
      const res = await t.inject({
        method: 'GET',
        url: `${prefix}/${photoName}?v=1`,
        anonymous: true,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/webp');
      expect(res.headers['cache-control']).toBe(
        'private, max-age=31536000, immutable',
      );
    }
  });

  it('is a 404 for a well-formed name with no photo behind it', async () => {
    expect(await status(`/file/${randomUUID()}.webp?v=1`)).toBe(404);
    expect(await status(`/file/thumb/${randomUUID()}.webp?v=1`)).toBe(404);
  });

  // An image request has no page to show: no session, no page context.
  it('answers a refused image as data, not an error page', async () => {
    const res = await t.inject({ method: 'GET', url: '/file/app.log' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.json()).toEqual({ statusCode: 404, message: 'Not Found' });
  });

  it('serves the share preview of a photo by its share id, signed out', async () => {
    const row = await photoRow(t, photoName);
    const res = await t.inject({
      method: 'GET',
      url: `/file/watermark/${row!.shareableId}`,
      anonymous: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['cache-control']).toBe('public, max-age=86400');
    expect((await sharp(res.rawPayload).metadata()).format).toBe('jpeg');

    expect(await status(`/file/watermark/${randomUUID()}`)).toBe(404);
  });

  it.each([
    '/file/app.log',
    '/file/thumb/app.log',
    '/file/nobg/app.log',
    '/file/sqlite3.db',
    '/file/.incoming',
    '/file/..%2Fapp.log',
  ])('refuses %s', async (url) => {
    await writeFile(join(t.dataPath, 'sqlite3.db'), 'not a photo');
    expect(await status(url)).toBe(404);
  });

  it('refuses a variant name on the original route', async () => {
    expect(await status(`/file/${variantFileName(photoName, 'thumb')}`)).toBe(
      404,
    );
  });

  /** Polls app.log (pino writes through a worker thread) for `marker`. */
  const logContaining = async (marker: string): Promise<string> => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const log = await readFile(join(t.dataPath, 'app.log'), 'utf8').catch(
        () => '',
      );
      if (log.includes(marker)) return log;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`app.log never logged ${marker}`);
  };

  it('never writes a cookie or authorization header, and skips static paths', async () => {
    await t.inject({ method: 'GET', url: '/healthz?probe=heartbeat-marker' });
    await t.inject({
      method: 'GET',
      url: `/file/thumb/${photoName}?v=thumb-marker`,
    });
    const credentials = {
      cookie: 'access_token=cookie-secret-sentinel',
      authorization: 'Bearer auth-secret-sentinel',
    };
    // Every request line is method, path, status and time, never headers,
    // pages and unknown paths alike (the logger's redaction is the net under
    // that: src/logger.spec.ts).
    await t.inject({
      method: 'GET',
      url: '/wardrobe?page=web-marker',
      headers: credentials,
    });
    await t.inject({
      method: 'GET',
      url: '/no-such-page?page=page-marker',
      headers: credentials,
    });

    // One transport, in order: once the page is logged, the earlier static
    // requests would be too if they were logged at all.
    const log = await logContaining('page-marker');
    expect(log).toContain('web-marker');
    expect(log).not.toContain('cookie-secret-sentinel');
    expect(log).not.toContain('auth-secret-sentinel');
    expect(log).not.toContain('heartbeat-marker');
    expect(log).not.toContain('thumb-marker');
  });
});

/**
 * #162: a URL imageUrl signed is served from storage without a statement
 * (a cold wardrobe grid was one statement per thumb over production's WiFi
 * link to the database). The signature names the set, so new bytes are
 * only ever reached through a new URL, and anything the signature does not
 * cover falls back to the row, as every request did before.
 */
describe('/file signed URLs', () => {
  let t: TestApp;
  let garmentId: number;
  let fileName: string;

  beforeAll(async () => {
    t = await createTestApp();
    garmentId = await createGarment(t, { name: 'Signed coat' });
    await uploadPhoto(t, garmentId, await jpegPhoto());
    fileName = await photoFileName(t, garmentId);
  });

  afterAll(() => t?.cleanup());

  /** The garment page's /file URLs, as the browser reads them. */
  const pageUrls = async () => {
    const page = unescapeHtml(
      (await t.inject({ method: 'GET', url: `/wardrobe/${garmentId}` })).body,
    );
    const find = (variant: string) => {
      const match = new RegExp(
        `"(/file/${variant}${fileName}\\?v=\\d+[^"]*&s=[A-Za-z0-9_-]{16})"`,
      ).exec(page);
      if (!match) throw new Error(`no signed /file/${variant} URL on the page`);
      return match[1];
    };
    return { original: find(''), nobg: find('nobg/') };
  };

  const get = (url: string) =>
    t.inject({ method: 'GET', url, anonymous: true });

  const saveMask = async () => {
    const body = await multipart(
      {},
      {
        nobgPhoto: {
          data: await pngCutout(),
          filename: 'cutout.png',
          contentType: 'image/png',
        },
      },
    );
    const res = await t.inject({
      method: 'POST',
      url: `/wardrobe/${garmentId}/nobg`,
      payload: body.payload,
      headers: body.headers,
    });
    expect(res.statusCode).toBe(200);
  };

  it('serves every variant of a signed URL without a statement, private and immutable', async () => {
    await saveMask();
    const urls = await pageUrls();
    const thumb = urls.nobg.replace('/file/nobg/', '/file/thumb/');
    for (const [url, variant] of [
      [urls.original, 'original'],
      [urls.nobg, 'nobg'],
      [thumb, 'thumb'],
    ] as const) {
      const stored = await readFile(await variantPath(t, fileName, variant));
      const record = await recordQueries(async () => {
        const res = await get(url);
        expect(res.statusCode).toBe(200);
        expect(res.headers['cache-control']).toBe(
          'private, max-age=31536000, immutable',
        );
        expect(res.rawPayload.equals(stored)).toBe(true);
      });
      expect(record.statements).toBe(0);
    }
  });

  it('asks the row for an unsigned or altered URL, one statement', async () => {
    const { nobg } = await pageUrls();
    const altered = [
      `/file/nobg/${fileName}?v=2`,
      nobg.replace(/&s=[^&]+/, '&s=AAAAAAAAAAAAAAAAAAAAAA'),
      nobg.replace(/&k=[^&]+/, '&k=ffffffffffff'),
    ];
    for (const url of altered) {
      const record = await recordQueries(async () => {
        expect((await get(url)).statusCode).toBe(200);
      });
      expect(record.statements).toBe(1);
    }
  });

  // Rotate, mask edit and cutout replacement all retire the set a URL
  // names: the old URL never reaches the new bytes through its signature,
  // and the new URL never the old ones.
  it('answers a URL whose set a new cutout retired through the row: the new bytes', async () => {
    const before = await pageUrls();
    await saveMask();
    const after = await pageUrls();
    expect(after.nobg).not.toBe(before.nobg);

    const current = await readFile(await variantPath(t, fileName, 'nobg'));
    const retired = await recordQueries(async () => {
      const res = await get(before.nobg);
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload.equals(current)).toBe(true);
    });
    expect(retired.statements).toBe(1);

    const fresh = await get(after.nobg);
    expect(fresh.rawPayload.equals(current)).toBe(true);
  });

  it('is a 404 for a signed URL once its garment is deleted', async () => {
    const urls = await pageUrls();
    const thumb = urls.nobg.replace('/file/nobg/', '/file/thumb/');
    const res = await t.inject({
      method: 'DELETE',
      url: `/wardrobe/${garmentId}`,
      headers: { 'hx-request': 'true' },
    });
    expect(res.statusCode).toBe(200);
    for (const url of [urls.original, urls.nobg, thumb]) {
      expect((await get(url)).statusCode).toBe(404);
    }
  });
});
