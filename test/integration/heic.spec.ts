import { readdir } from 'node:fs/promises';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createGarment, garmentRow, photoRowCount } from './garments';
import { createTestApp, multipart, TestApp } from './harness';

/**
 * HEIC parts go through heic-decode before sharp. This file covers the
 * rejection paths against the real decoder with a tiny byte cap; a real
 * iPhone-style HEIC decoding end to end is heic-real.spec.ts (the cap is read
 * once per app, so it needs its own file).
 */
describe('HEIC uploads (POST /wardrobe/:id/photo)', () => {
  let t: TestApp;
  const MAX_HEIC_BYTES = 2048;

  const storedFiles = async () =>
    (await readdir(t.dataPath)).filter((name) => name.endsWith('.webp'));

  const upload = async (
    garmentId: number,
    data: Buffer,
    contentType: string,
    filename: string,
  ) => {
    const body = await multipart(
      {},
      { photo: { data, filename, contentType } },
    );
    return t.inject({
      method: 'POST',
      url: `/wardrobe/${garmentId}/photo`,
      payload: body.payload,
      headers: body.headers,
    });
  };

  const expectNothingStored = async (
    garmentId: number,
    filesBefore: string[],
    rowsBefore: number,
  ) => {
    expect(await storedFiles()).toEqual(filesBefore);
    expect(await photoRowCount(t)).toBe(rowsBefore);
    expect((await garmentRow(t, garmentId))?.photo).toBeNull();
  };

  // Vitest does not exit on an unhandled rejection the way Node does; it
  // fails the run with a file-level "Unhandled Rejection". Recording them
  // pins the crash this file guards against on the upload that caused it.
  const unhandled: unknown[] = [];
  const recordUnhandled = (reason: unknown) => unhandled.push(reason);

  beforeAll(async () => {
    process.on('unhandledRejection', recordUnhandled);
    t = await createTestApp({ MAX_HEIC_BYTES: String(MAX_HEIC_BYTES) });
  });

  afterAll(async () => {
    process.off('unhandledRejection', recordUnhandled);
    await t?.cleanup();
  });
  afterEach(() => vi.restoreAllMocks());

  // The photo pipeline is started inside the multipart loop without an
  // awaiting caller (Photos.storeUploadParts); a decode
  // failure there used to be an unhandled rejection that killed the process.
  // Each case therefore also checks the app answers the next request.
  it.each([
    ['image/heic', 'photo.heic', 'undecodable HEIC'],
    ['image/heif', 'photo.heif', 'undecodable HEIC'],
    ['application/octet-stream', 'IMG_0042.HEIC', 'undecodable HEIC'],
    ['image/jpeg', 'photo.jpg', 'unreadable upload'],
  ])(
    '%s %s with undecodable bytes is a 400, leaves nothing behind and the app survives',
    async (contentType: string, filename: string, warning: string) => {
      const garmentId = await createGarment(t, { name: filename });
      const filesBefore = await storedFiles();
      const rowsBefore = await photoRowCount(t);
      t.logs.clear();

      const res = await upload(
        garmentId,
        Buffer.from('this is not an image container at all'),
        contentType,
        filename,
      );
      expect(res.statusCode).toBe(400);
      // The decoder, not the generic mimetype check, rejected it.
      expect(t.logs.messages('warn', 'Photos')).toEqual(
        expect.arrayContaining([expect.stringContaining(warning)]),
      );
      await expectNothingStored(garmentId, filesBefore, rowsBefore);

      const next = await t.inject({
        method: 'GET',
        url: `/wardrobe/${garmentId}`,
      });
      expect(next.statusCode).toBe(200);
      // Rejections are reported a tick after they are orphaned.
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    },
  );

  it('a HEIC part over MAX_HEIC_BYTES is a 413 that leaves nothing behind', async () => {
    const garmentId = await createGarment(t, { name: 'Huge' });
    const filesBefore = await storedFiles();
    const rowsBefore = await photoRowCount(t);

    const res = await upload(
      garmentId,
      Buffer.alloc(MAX_HEIC_BYTES + 1, 1),
      'image/heic',
      'huge.heic',
    );
    expect(res.statusCode).toBe(413);
    await expectNothingStored(garmentId, filesBefore, rowsBefore);
  });

  it('the photo inputs accept HEIC', async () => {
    const garmentId = await createGarment(t, { name: 'Inputs' });
    const page = await t.inject({
      method: 'GET',
      url: `/wardrobe/${garmentId}`,
    });
    const accepts: string[] = page.body.match(/accept="[^"]*"/g) ?? [];
    const photoInputs = accepts.filter((a) => a.includes('image/jpeg'));
    expect(photoInputs.length).toBeGreaterThanOrEqual(2);
    for (const accept of photoInputs) {
      expect(accept).toContain('image/heic');
      expect(accept).toContain('image/heif');
      expect(accept).toContain('.heic');
    }
  });
});
