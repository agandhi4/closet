import { readdir } from 'node:fs/promises';
import { Logger as PinoLogger } from 'nestjs-pino';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { Garment } from '../../src/dal/entity/garment.entity';
import { createGarment, photoRowCount } from './garments';
import { createTestApp, multipart, TestApp } from './harness';

/**
 * HEIC parts go through heic-convert before sharp. There is no HEIC fixture
 * in the tree (libheif does not encode, and nothing in node_modules ships a
 * sample), so this covers the rejection paths against the real decoder; the
 * successful decode is unit-tested with heic-convert mocked
 * (src/web/files/photos.spec.ts).
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
    const garment = await t
      .em()
      .findOneOrFail(Garment, garmentId, { populate: ['photo'] });
    expect(garment.photo).toBeFalsy();
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
  // awaiting caller (GarmentService.storeUploadedPhotoWithCutout); a decode
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
      const warn = vi.spyOn(t.app.get(PinoLogger), 'warn');

      const res = await upload(
        garmentId,
        Buffer.from('this is not an image container at all'),
        contentType,
        filename,
      );
      expect(res.statusCode).toBe(400);
      // The decoder, not the generic mimetype check, rejected it.
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(warning),
        expect.anything(),
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
