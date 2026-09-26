import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { variantFileName } from '../../src/web/files/image-variant';
import {
  createGarment,
  jpegPhoto,
  photoFileName,
  photoRow,
  pngCutout,
  uploadPhoto,
} from './garments';
import { createTestApp, multipart, TestApp } from './harness';

describe('mask edit (POST /wardrobe/:id/nobg)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  it('replaces the cutout, rewrites the thumb and bumps the version', async () => {
    const garmentId = await createGarment(t, { name: 'Red jacket' });
    await uploadPhoto(t, garmentId, await jpegPhoto());
    const fileName = await photoFileName(t, garmentId);
    const thumbPath = join(t.dataPath, variantFileName(fileName, 'thumb'));
    const nobgPath = join(t.dataPath, variantFileName(fileName, 'nobg'));
    const thumbBefore = await readFile(thumbPath);
    expect((await sharp(thumbBefore).metadata()).hasAlpha).toBe(false);

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
    expect(res.statusCode).toBeLessThan(300);
    expect(res.json()).toEqual({ version: 2 });

    const nobg = await sharp(nobgPath).metadata();
    expect(nobg.format).toBe('webp');
    expect(nobg.hasAlpha).toBe(true);

    // The thumb is derived from the cutout once one exists.
    const thumbAfter = await readFile(thumbPath);
    expect(thumbAfter.equals(thumbBefore)).toBe(false);
    expect((await sharp(thumbAfter).metadata()).hasAlpha).toBe(true);

    // The user's mask: no server job result may replace it (src/cutout/state.ts).
    expect(await photoRow(t, fileName)).toMatchObject({
      version: 2,
      cutoutStatus: 'edited',
    });

    const grid = await t.inject({ method: 'GET', url: '/wardrobe' });
    expect(grid.body).toContain(`/file/thumb/${fileName}?v=2`);
    expect(grid.body).not.toContain(`/file/thumb/${fileName}?v=1`);

    const served = await t.inject({
      method: 'GET',
      url: `/file/nobg/${fileName}?v=2`,
    });
    expect(served.statusCode).toBe(200);
    expect(served.rawPayload.equals(await readFile(nobgPath))).toBe(true);
  });
});
