import { readdir } from 'node:fs/promises';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Garment } from '../../src/dal/entity/garment.entity';
import { variantFileName } from '../../src/web/files/image-variant';
import { createGarment, jpegPhoto } from './garments';
import { createTestApp, multipart, TestApp } from './harness';

/**
 * The garment form sends the photo and its browser-made cutout in one
 * multipart request, and both are stored concurrently. The cutout of a real
 * phone photo is large and noisy, so it is still being written when the
 * photo's pipeline finishes. Every earlier fixture was a small flat-colour
 * PNG that always won the race, which is how "every real upload with a
 * cutout fails with 500" reached production.
 */
describe('photo + cutout upload', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  /** Noise does not compress: a phone-sized cutout, several MB of PNG. */
  const noisyCutout = (size: number) =>
    sharp({
      create: {
        width: size,
        height: size,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
        noise: { type: 'gaussian', mean: 128, sigma: 60 },
      },
    })
      .png()
      .toBuffer();

  it('stores the photo, the cutout and one thumb derived from the cutout', async () => {
    const garmentId = await createGarment(t, { name: 'Linen blazer' });
    const cutout = await noisyCutout(2400);
    expect(cutout.length).toBeGreaterThan(5_000_000);

    const body = await multipart(
      {},
      {
        photo: {
          data: await jpegPhoto(1200, 800),
          filename: 'photo.jpg',
          contentType: 'image/jpeg',
        },
        nobgPhoto: {
          data: cutout,
          filename: 'photo-nobg.png',
          contentType: 'image/png',
        },
      },
    );
    const res = await t.inject({
      method: 'POST',
      url: `/wardrobe/${garmentId}/photo`,
      payload: body.payload,
      headers: body.headers,
    });
    expect(res.statusCode).toBeLessThan(300);
    expect(res.headers['hx-redirect']).toBe(
      `/wardrobe/${garmentId}?photoSaved=1`,
    );

    const garment = await t
      .em()
      .findOneOrFail(Garment, garmentId, { populate: ['photo'] });
    const fileName = garment.photo!.fileName;
    const stored = await readdir(t.dataPath);
    expect(stored).toEqual(
      expect.arrayContaining([
        fileName,
        variantFileName(fileName, 'nobg'),
        variantFileName(fileName, 'thumb'),
      ]),
    );

    // The thumb comes from the square cutout, not the 3:2 photo.
    const thumb = await sharp(
      `${t.dataPath}/${variantFileName(fileName, 'thumb')}`,
    ).metadata();
    expect(thumb.width).toBe(400);
    expect(thumb.height).toBe(400);
  }, 60_000);
});
