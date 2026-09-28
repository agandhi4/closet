import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { imageUrl } from '../../src/web/files/image-url';
import { readPhotoRef } from '../../src/web/files/queries';
import { variantFileName } from '../../src/web/files/image-variant';
import {
  createGarment,
  jpegPhoto,
  photoFileName,
  photoRow,
  pngCutout,
  uploadPhoto,
} from './garments';
import { variantPath } from './cutouts';
import { createTestApp, multipart, recordQueries, TestApp } from './harness';

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
    const thumbBefore = await readFile(
      join(t.dataPath, variantFileName(fileName, 'thumb')),
    );
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
    const saved = res.json<{
      version: number;
      originalUrl: string;
      nobgUrl: string;
    }>();
    expect(saved.version).toBe(2);

    // Stored under the row's new variant key (#141); the thumb it replaced
    // is gone.
    const nobgPath = await variantPath(t, fileName, 'nobg');
    const thumbPath = await variantPath(t, fileName, 'thumb');
    expect(nobgPath).toMatch(/-nobg-[0-9a-f]{12}\.webp$/);
    await expect(
      stat(join(t.dataPath, variantFileName(fileName, 'thumb'))),
    ).rejects.toMatchObject({ code: 'ENOENT' });
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

    // The answer's URLs name the new set: the editor's image reads it
    // without a statement (#162).
    const key = nobgPath.match(/-nobg-([0-9a-f]{12})\.webp$/)![1];
    expect(saved.nobgUrl).toMatch(
      new RegExp(`^/file/nobg/${fileName}\\?v=2&k=${key}&s=`),
    );
    expect(saved.originalUrl).toMatch(
      new RegExp(`^/file/${fileName}\\?v=2&k=${key}&s=`),
    );
    const served = await recordQueries(() =>
      t.inject({ method: 'GET', url: saved.nobgUrl }),
    );
    expect(served.statements).toBe(0);
    const bytes = await t.inject({ method: 'GET', url: saved.nobgUrl });
    expect(bytes.statusCode).toBe(200);
    expect(bytes.rawPayload.equals(await readFile(nobgPath))).toBe(true);

    // A script from before the answer had URLs rewrote only `v` of the
    // old signed URL: the signature covers it, so the row answers, with
    // the new set, never the old one under the new version.
    const before = imageUrl(
      readPhotoRef({ fileName, version: 1, variantKey: null }),
      'nobg',
    );
    const rewritten = await t.inject({
      method: 'GET',
      url: before.replace('?v=1&', '?v=2&'),
    });
    expect(rewritten.statusCode).toBe(200);
    expect(rewritten.rawPayload.equals(await readFile(nobgPath))).toBe(true);
  });
});
