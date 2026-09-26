import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { file } from '../../src/db/schema';
import { fakeRunner, halfMask, storedCutout } from './cutouts';
import {
  createGarment,
  garmentRow,
  jpegPhoto,
  photoFileName,
  photoRow,
  pngCutout,
  uploadPhoto,
} from './garments';
import {
  createTestApp,
  multipart,
  type TestApp,
  unescapeHtml,
} from './harness';
import {
  expectFragment,
  expectNativePostForms,
  expectNoRawI18nKeys,
  HX_FRAGMENT,
} from './pages';

/**
 * The garment photo flow: the upload is queued, the page shows the cutout
 * pending and polls a fragment that swaps it in, a failure offers a
 * native-post "Try again". The browser never removes a background.
 */
describe('cutouts: upload, page and polling', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterEach(async () => {
    await t.cutouts.stop();
  });

  afterAll(() => t?.cleanup());

  const page = async (id: number) =>
    t.inject({ method: 'GET', url: `/wardrobe/${id}` });
  const fragment = async (id: number) =>
    t.inject({
      method: 'GET',
      url: `/wardrobe/${id}/cutout`,
      headers: HX_FRAGMENT,
    });

  it('queues an uploaded photo and shows it pending, polling', async () => {
    const id = await createGarment(t, { name: 'Pending shirt' });
    await uploadPhoto(t, id, await jpegPhoto());
    const fileName = await photoFileName(t, id);

    expect(await photoRow(t, fileName)).toMatchObject({
      cutoutStatus: 'pending',
      cutoutAttempts: 0,
      cutoutJobVersion: null,
      version: 1,
    });
    expect((await photoRow(t, fileName))!.cutoutRequestedAt).toBeInstanceOf(
      Date,
    );
    expect(await storedCutout(t, fileName)).toBeUndefined();
    expect(t.logs.messages('info', 'Web')).toContain(
      `Garment ${id} photo ${fileName} queued for background removal`,
    );

    const res = await page(id);
    expect(res.statusCode).toBe(200);
    const html = unescapeHtml(res.body);
    expect(html).toMatch(
      new RegExp(
        `<div id="garment-photo" class="mb-6" hx-get="/wardrobe/${id}/cutout" hx-trigger="every 2s" hx-swap="outerHTML" hx-indicator="#garment-photo-status">`,
      ),
    );
    expect(html).toContain('Removing background…');
    // Nothing to edit yet; the form posts the photo alone.
    expect(html).not.toContain('id="editMaskBtn"');
    expect(html).not.toContain('name="nobgPhoto"');
    expect(html).toContain(`import { wirePhotoUpload } from 'photo-input';`);
    expectNativePostForms(res);
    expectNoRawI18nKeys(res);
  });

  it('swaps the cutout in once the queue has made it, and stops polling', async () => {
    const id = await createGarment(t, { name: 'Ready shirt' });
    await uploadPhoto(t, id, await jpegPhoto());
    const fileName = await photoFileName(t, id);
    expect(unescapeHtml((await fragment(id)).body)).toContain(
      'hx-trigger="every 2s"',
    );

    t.cutouts.start(fakeRunner());
    await t.cutouts.whenIdle();

    const res = await fragment(id);
    expectFragment(res);
    const html = unescapeHtml(res.body);
    expect(html).toMatch(/^<div id="garment-photo" class="mb-6">/);
    expect(html).not.toContain('hx-trigger');
    expect(html).toContain(`src="/file/nobg/${fileName}?v=2"`);
    expect(html).toContain(`data-nobg-url="/file/nobg/${fileName}?v=2"`);
    expect(html).toContain(`data-save-url="/wardrobe/${id}/nobg"`);
    expect(await storedCutout(t, fileName)).toBeDefined();
  });

  it('shows a failed cutout with a native-post "Try again" that requeues it', async () => {
    const id = await createGarment(t, { name: 'Failed shirt' });
    await uploadPhoto(t, id, await jpegPhoto());
    const fileName = await photoFileName(t, id);
    t.cutouts.start(
      fakeRunner((call) => {
        if (call === 1) throw new Error('model exploded');
        return halfMask();
      }),
    );
    await t.cutouts.whenIdle();

    const failed = await fragment(id);
    const html = unescapeHtml(failed.body);
    expect(html).not.toContain('hx-trigger');
    expect(html).toContain('The background could not be removed.');
    expect(html).toContain(
      `<form method="post" action="/wardrobe/${id}/cutout/retry" hx-boost="false">`,
    );
    // The original shows, and the user may still clear it by hand.
    expect(html).toContain('id="editMaskBtn"');
    expectNativePostForms(await page(id));

    const retry = await t.inject({
      method: 'POST',
      url: `/wardrobe/${id}/cutout/retry`,
    });
    expect(retry.statusCode).toBe(303);
    expect(retry.headers.location).toBe(`/wardrobe/${id}`);
    await t.cutouts.whenIdle();
    expect(await photoRow(t, fileName)).toMatchObject({
      cutoutStatus: 'ready',
      cutoutAttempts: 2,
    });

    // A retry of a ready cutout changes nothing.
    await t.inject({ method: 'POST', url: `/wardrobe/${id}/cutout/retry` });
    expect(await photoRow(t, fileName)).toMatchObject({
      cutoutStatus: 'ready',
    });
  });

  // Pages an installed PWA cached before background removal moved to the
  // server post the browser's cutout with the photo, in either order.
  it.each([
    ['after', ['photo', 'nobgPhoto']],
    ['before', ['nobgPhoto', 'photo']],
  ] as const)(
    'ignores a cutout sent %s the photo by a page cached before the server made them, and queues its own',
    async (_order, fields) => {
      const id = await createGarment(t, { name: `Old page shirt ${_order}` });
      const parts = {
        photo: {
          data: await jpegPhoto(),
          filename: 'photo.jpg',
          contentType: 'image/jpeg',
        },
        nobgPhoto: {
          data: await pngCutout(),
          filename: 'nobg.webp',
          contentType: 'image/webp',
        },
      };
      const body = await multipart(
        {},
        Object.fromEntries(fields.map((field) => [field, parts[field]])),
      );
      const res = await t.inject({
        method: 'POST',
        url: `/wardrobe/${id}/photo`,
        payload: body.payload,
        headers: body.headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['hx-redirect']).toBe(`/wardrobe/${id}?photoSaved=1`);
      const fileName = await photoFileName(t, id);
      expect(await photoRow(t, fileName)).toMatchObject({
        cutoutStatus: 'pending',
      });
      expect(await storedCutout(t, fileName)).toBeUndefined();
      expect(t.logs.messages('info', 'Photos')).toContainEqual(
        expect.stringMatching(/ignored the browser's cutout/),
      );
    },
  );

  it('refuses a cutout without its photo, storing nothing', async () => {
    const id = await createGarment(t, { name: 'Lone cutout shirt' });
    const body = await multipart(
      {},
      {
        nobgPhoto: {
          data: await pngCutout(),
          filename: 'nobg.webp',
          contentType: 'image/webp',
        },
      },
    );
    const res = await t.inject({
      method: 'POST',
      url: `/wardrobe/${id}/photo`,
      payload: body.payload,
      headers: body.headers,
    });
    expect(res.statusCode).toBe(400);
    expect((await garmentRow(t, id))?.photo).toBeNull();
  });

  it('shows a photo stored before server-side removal as it is: no polling, the pencil', async () => {
    const id = await createGarment(t, { name: 'Legacy shirt' });
    await uploadPhoto(t, id, await jpegPhoto());
    const fileName = await photoFileName(t, id);
    await t.db
      .update(file)
      .set({ cutoutStatus: 'none', cutoutRequestedAt: null })
      .where(eq(file.fileName, fileName));

    const html = unescapeHtml((await page(id)).body);
    expect(html).toContain('<div id="garment-photo" class="mb-6">');
    expect(html).not.toContain('hx-trigger="every 2s"');
    expect(html).toContain('id="editMaskBtn"');
  });

  it('queues the copy of a pending photo when the garment is cloned', async () => {
    const id = await createGarment(t, { name: 'Cloned shirt' });
    await uploadPhoto(t, id, await jpegPhoto());
    const res = await t.inject({
      method: 'POST',
      url: `/wardrobe/${id}/clone`,
      payload: { name: 'Cloned shirt copy', category: 'shirt' },
    });
    expect(res.statusCode).toBe(302);
    const cloneId = Number(/\/wardrobe\/(\d+)/.exec(res.headers.location!)![1]);
    const clone = await garmentRow(t, cloneId);
    expect(clone?.photo).toMatchObject({
      cutoutStatus: 'pending',
      cutoutAttempts: 0,
    });
  });

  it('answers the fragment for a garment the requester cannot see with a 404', async () => {
    const id = await createGarment(t, { name: 'Private shirt' });
    const stranger = await t.register('stranger@example.com');
    const res = await t.inject({
      method: 'GET',
      url: `/wardrobe/${id}/cutout`,
      headers: { ...HX_FRAGMENT, cookie: stranger },
    });
    expect(res.statusCode).toBe(404);
  });
});
