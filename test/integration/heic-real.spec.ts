import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Garment } from '../../src/dal/entity/garment.entity';
import { variantFileName } from '../../src/web/files/image-variant';
import { createGarment } from './garments';
import { createTestApp, multipart, TestApp } from './harness';

/**
 * A real HEIC through the real decoder (heic-decode / libheif-js WebAssembly),
 * the way an iPhone uploads it: the photo inputs accept image/heic, so iOS
 * sends the original file. test/fixtures/example.heic is libheif's own
 * example image (github.com/strukturag/libheif, examples/example.heic).
 * heic.spec.ts covers the rejection paths with a tiny byte cap; this file
 * keeps the default cap.
 */
describe('a real HEIC upload', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  it('stores the original, and a thumb, as WebP with the photo shape', async () => {
    const heic = await readFile(join(__dirname, '../fixtures/example.heic'));
    const garmentId = await createGarment(t, { name: 'From an iPhone' });
    const body = await multipart(
      {},
      {
        photo: {
          data: heic,
          filename: 'IMG_0001.HEIC',
          contentType: 'image/heic',
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

    const garment = await t
      .em()
      .findOneOrFail(Garment, garmentId, { populate: ['photo'] });
    const name = garment.photo!.fileName;
    const original = await sharp(join(t.dataPath, name)).metadata();
    const thumb = await sharp(
      join(t.dataPath, variantFileName(name, 'thumb')),
    ).metadata();

    expect(original.format).toBe('webp');
    expect(Math.max(original.width, original.height)).toBeLessThanOrEqual(1080);
    expect(Math.max(original.width, original.height)).toBeGreaterThan(400);
    expect(thumb.format).toBe('webp');
    expect(Math.max(thumb.width, thumb.height)).toBe(400);
    // Same shape: the thumb is the original scaled, not cropped or rotated.
    expect(thumb.width / thumb.height).toBeCloseTo(
      original.width / original.height,
      1,
    );
  }, 60_000);
});
