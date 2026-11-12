import { readdir, readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { retrimCutoutThumbs } from '../../src/maintenance/retrim-thumbs';
import { variantFileName } from '../../src/web/files/image-variant';
import { variantPath } from './cutouts';
import {
  createGarment,
  jpegPhoto,
  photoFileName,
  photoRow,
  uploadPhoto,
} from './garments';
import { createTestApp, multipart, TestApp } from './harness';
import { silentLogger } from './logger';

/**
 * The #373 backfill against the real app: a cutout's thumb from before the
 * trim is replaced under a new variant key (so a new URL), the set it
 * replaced is gone, a dry run changes nothing, and a second run finds the
 * thumb current.
 */
describe('maintenance:retrim-thumbs', () => {
  let t: TestApp;
  const retrim = (dryRun = false) =>
    retrimCutoutThumbs(
      { db: t.db, photos: t.photos, logger: silentLogger },
      { dryRun },
    );
  const storedFiles = async () =>
    (await readdir(t.dataPath)).filter((name) => name.endsWith('.webp')).sort();

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  it('gives an edited cutout its trimmed thumb under a new key, once', async () => {
    // A photo whose cutout is still queued: no cutout, not the job's.
    await uploadPhoto(
      t,
      await createGarment(t, { name: 'Queued' }),
      await jpegPhoto(),
    );

    const garmentId = await createGarment(t, { name: 'Framed wide' });
    await uploadPhoto(t, garmentId, await jpegPhoto());
    const fileName = await photoFileName(t, garmentId);
    // The garment small in a corner of the frame, as the mask editor saves it.
    const mask = await sharp({
      create: {
        width: 800,
        height: 800,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([
        {
          input: {
            create: {
              width: 160,
              height: 240,
              channels: 4,
              background: { r: 200, g: 30, b: 30, alpha: 1 },
            },
          },
          left: 40,
          top: 500,
        },
      ])
      .png()
      .toBuffer();
    const body = await multipart(
      {},
      {
        nobgPhoto: {
          data: mask,
          filename: 'cutout.png',
          contentType: 'image/png',
        },
      },
    );
    const edit = await t.inject({
      method: 'POST',
      url: `/wardrobe/${garmentId}/nobg`,
      payload: body.payload,
      headers: body.headers,
    });
    expect(edit.statusCode).toBeLessThan(300);

    // The thumb as it was made before #373: the whole frame.
    const nobgPath = await variantPath(t, fileName, 'nobg');
    const thumbPath = await variantPath(t, fileName, 'thumb');
    const cutout = await readFile(nobgPath);
    await writeFile(
      thumbPath,
      await sharp(cutout).resize(400, 400, { fit: 'inside' }).webp().toBuffer(),
    );
    const before = await photoRow(t, fileName);
    const filesBefore = await storedFiles();

    expect(await retrim(true)).toEqual({
      dryRun: true,
      photos: 1,
      retrimmed: 0,
      due: 1,
      current: 0,
      missingCutouts: 0,
      refused: 0,
      failed: 0,
      durationMs: expect.any(Number),
    });
    expect(await storedFiles()).toEqual(filesBefore);
    expect(await photoRow(t, fileName)).toEqual(before);

    expect(await retrim()).toMatchObject({ photos: 1, retrimmed: 1 });
    const after = await photoRow(t, fileName);
    expect(after).toMatchObject({
      cutoutStatus: 'edited',
      version: before!.version + 1,
    });
    expect(after!.variantKey).not.toBe(before!.variantKey);
    // The same cutout under the new key; the set it replaced is gone.
    expect(
      (await readFile(await variantPath(t, fileName, 'nobg'))).equals(cutout),
    ).toBe(true);
    const old = [
      variantFileName(fileName, 'nobg', before!.variantKey),
      variantFileName(fileName, 'thumb', before!.variantKey),
    ];
    const filesAfter = await storedFiles();
    expect(filesAfter).not.toContain(old[0]);
    expect(filesAfter).not.toContain(old[1]);
    // Trimmed: the garment fills the square tile.
    const thumb = await sharp(await variantPath(t, fileName, 'thumb'))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect([thumb.info.width, thumb.info.height]).toEqual([400, 400]);
    expect(thumb.data[(200 * 400 + 200) * 4 + 3]).toBe(255);
    // The grid names the new set, so no cache serves the old thumb.
    const grid = await t.inject({ method: 'GET', url: '/wardrobe' });
    expect(grid.body).toMatch(
      new RegExp(
        `/file/thumb/${fileName}\\?v=${after!.version}&(amp;)?k=${after!.variantKey}`,
      ),
    );

    expect(await retrim()).toMatchObject({
      photos: 1,
      retrimmed: 0,
      current: 1,
    });
    expect((await photoRow(t, fileName))!.version).toBe(after!.version);
  });
});
