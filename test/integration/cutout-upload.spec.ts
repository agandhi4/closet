import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
 * The garment photo flow in CUTOUT_MODE=server: the upload is queued, the
 * page shows the cutout pending and polls a fragment that swaps it in, a
 * failure offers a native-post "Try again". Client mode keeps the
 * in-browser flow and none of these routes.
 */
describe('server cutouts: upload, page and polling (CUTOUT_MODE=server)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ CUTOUT_MODE: 'server' });
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

  it('queues an uploaded photo and shows it pending, polling, without the in-browser model', async () => {
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
    // Nothing to edit yet; no toggle, no cutout field, no model module.
    expect(html).not.toContain('id="editMaskBtn"');
    expect(html).not.toContain('bgRemovalToggle');
    expect(html).not.toContain('nobgPhotoInput');
    expect(html).toContain(`import { wirePhotoUpload } from 'photo-input';`);
    expect(html).not.toContain('/js/background-removal.js');
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

  it('keeps a cutout the browser sent with the photo (a page from before the switch)', async () => {
    const id = await createGarment(t, { name: 'Old page shirt' });
    const body = await multipart(
      {},
      {
        photo: {
          data: await jpegPhoto(),
          filename: 'photo.jpg',
          contentType: 'image/jpeg',
        },
        nobgPhoto: {
          data: await pngCutout(),
          filename: 'nobg.png',
          contentType: 'image/png',
        },
      },
    );
    const res = await t.inject({
      method: 'POST',
      url: `/wardrobe/${id}/photo`,
      payload: body.payload,
      headers: body.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(await photoRow(t, await photoFileName(t, id))).toMatchObject({
      cutoutStatus: 'none',
    });
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

describe('client mode keeps the in-browser flow (CUTOUT_MODE=client, the default)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  it('queues nothing, loads the in-browser model module and has no cutout routes', async () => {
    const id = await createGarment(t, { name: 'Client shirt' });
    await uploadPhoto(t, id, await jpegPhoto());
    expect(await photoRow(t, await photoFileName(t, id))).toMatchObject({
      cutoutStatus: 'none',
    });

    const res = await t.inject({ method: 'GET', url: `/wardrobe/${id}` });
    const html = unescapeHtml(res.body);
    expect(html).toContain('/js/background-removal.js?v=');
    expect(html).not.toContain('wirePhotoUpload');
    expect(html).toContain('id="bgRemovalToggle"');
    expect(html).toContain('id="nobgPhotoInput"');
    expect(html).toContain('<div id="garment-photo" class="mb-6">');
    expect(html).not.toContain('hx-trigger="every 2s"');
    expect(html).toContain('id="editMaskBtn"');

    for (const [method, url] of [
      ['GET', `/wardrobe/${id}/cutout`],
      ['POST', `/wardrobe/${id}/cutout/retry`],
    ] as const) {
      expect((await t.inject({ method, url })).statusCode).toBe(404);
    }
  });
});
