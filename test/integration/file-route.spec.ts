import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Garment } from '../../src/dal/entity/garment.entity';
import { variantFileName } from '../../src/web/files/image-variant';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createGarment, jpegPhoto, photoRow, uploadPhoto } from './garments';
import { createTestApp, TestApp } from './harness';

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
    // Logging on: the redaction assertions read the real app.log.
    t = await createTestApp({ LOG_LEVEL: 'info' });
    const garmentId = await createGarment(t, { name: 'Wool coat' });
    await uploadPhoto(t, garmentId, await jpegPhoto());
    const garment = await t
      .em()
      .findOneOrFail(Garment, garmentId, { populate: ['photo'] });
    photoName = garment.photo!.fileName;
  });

  afterAll(() => t?.cleanup());

  const status = async (url: string) =>
    (await t.inject({ method: 'GET', url })).statusCode;

  it('serves a photo and its variants by base name', async () => {
    expect(await status(`/file/${photoName}?v=1`)).toBe(200);
    expect(await status(`/file/thumb/${photoName}?v=1`)).toBe(200);
    expect(await status(`/file/nobg/${photoName}?v=1`)).toBe(200);
  });

  it('serves every variant as immutable WebP for a year', async () => {
    for (const prefix of ['/file', '/file/nobg', '/file/thumb']) {
      const res = await t.inject({
        method: 'GET',
        url: `${prefix}/${photoName}?v=1`,
        anonymous: true,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/webp');
      expect(res.headers['cache-control']).toBe(
        'public, max-age=31536000, immutable',
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
    // A web-layer page logs its own line (method, path, status), never
    // headers; a request Nest answers (an unknown path) goes through
    // pino-http, which logs headers and must redact these.
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
    expect(log).toContain('[redacted]');
    expect(log).not.toContain('heartbeat-marker');
    expect(log).not.toContain('thumb-marker');
  });
});
