import type { RouteOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PHOTO_UPLOAD_LIMIT } from '../../src/web/security/rate-limit';
import { deviceToken, expectProblem } from './api';
import { createGarment } from './garments';
import { createTestApp, multipart, type TestApp } from './harness';
import { routeKeysOf } from './app-routes';

/**
 * PHOTO_UPLOAD_LIMIT (#699): every route that reads an uploaded file says
 * `config: { photoUpload: true }` and counts on one budget per user, the
 * page's and the API's doors together; a multipart body anywhere else is a
 * 415, so an upload route without the mark refuses its own uploads.
 */
describe('the photo upload limit', () => {
  let t: TestApp;
  const routes: RouteOptions[] = [];

  /** A one-part multipart body whose bytes no decoder reads: cheap to refuse. */
  const garbagePart = () =>
    multipart(
      {},
      {
        photo: {
          data: Buffer.from('not an image'),
          filename: 'x.jpg',
          contentType: 'image/jpeg',
        },
      },
    );

  beforeAll(async () => {
    t = await createTestApp({}, { onRoute: (route) => routes.push(route) });
  });
  afterAll(() => t?.cleanup());

  it('marks every upload route, pages and API alike, and nothing else', () => {
    const marked = routes
      .filter((route) => route.config?.photoUpload === true)
      .flatMap(routeKeysOf)
      .sort();
    expect(marked).toEqual(
      [
        'POST /wardrobe/new/photo',
        'POST /wardrobe/:id/photo',
        'POST /wardrobe/:id/nobg',
        'POST /calendar/:id/selfie',
        'POST /inspiration',
        'POST /inspiration/:id/photo',
        'PUT /api/v1/garments/:id/photo',
        'PUT /api/v1/garments/:id/photo/cutout',
        'PUT /api/v1/calendar-entries/:id/selfie',
        'POST /api/v1/looks',
        'PUT /api/v1/looks/:id/photo',
      ].sort(),
    );
  });

  it('refuses a multipart body to a route that takes no upload, at either door', async () => {
    const garmentId = await createGarment(t, { name: 'Not an upload' });
    const page = await garbagePart();
    const refused = await t.inject({
      method: 'POST',
      url: `/wardrobe/${garmentId}/cutout/retry`,
      payload: page.payload,
      headers: page.headers,
    });
    expect(refused.statusCode).toBe(415);

    const { token } = await deviceToken(t);
    const api = await garbagePart();
    expectProblem(
      await t.api(token, {
        method: 'POST',
        url: `/api/v1/garments/${garmentId}/photo/cutout/retries`,
        payload: api.payload,
        headers: api.headers,
      }),
      415,
      'validation',
    );
  });

  it("counts a user's page and API uploads on one budget, and only theirs", async () => {
    const garmentId = await createGarment(t, { name: 'Many uploads' });
    const { token } = await deviceToken(t);
    for (let upload = 0; upload < PHOTO_UPLOAD_LIMIT.max; upload++) {
      const body = await garbagePart();
      const res = await t.inject({
        method: 'POST',
        url: `/wardrobe/${garmentId}/photo`,
        payload: body.payload,
        headers: body.headers,
      });
      // Counted before the body is read: an unreadable upload spends one.
      expect(res.statusCode).toBe(400);
    }

    const api = await garbagePart();
    const throttled = await t.api(token, {
      method: 'PUT',
      url: `/api/v1/garments/${garmentId}/photo`,
      payload: api.payload,
      headers: api.headers,
    });
    expectProblem(throttled, 429, 'rate_limited');
    expect(Number(throttled.headers['retry-after'])).toBeGreaterThan(0);

    const other = await t.register('other-uploader@example.com');
    const theirs = await createGarment(t, { name: 'Theirs', cookie: other });
    const body = await garbagePart();
    const res = await t.inject({
      method: 'POST',
      url: `/wardrobe/${theirs}/photo`,
      payload: body.payload,
      headers: { ...body.headers, cookie: other },
    });
    expect(res.statusCode).toBe(400);
  });
});
