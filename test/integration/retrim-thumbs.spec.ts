import { readdir, readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type RetrimOptions,
  retrimCutoutThumbs,
} from '../../src/maintenance/retrim-thumbs';
import { variantFileName } from '../../src/web/files/image-variant';
import type { Photos } from '../../src/web/files/photos';
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
 * replaced is gone, a dry run changes nothing, a second run finds the thumb
 * current, and a stop lands between photos, never inside one.
 */
describe('maintenance:retrim-thumbs', () => {
  let t: TestApp;
  const retrim = (options: RetrimOptions = {}, photos: Photos = t.photos) =>
    retrimCutoutThumbs({ db: t.db, photos, logger: silentLogger }, options);
  const storedFiles = async () =>
    (await readdir(t.dataPath)).filter((name) => name.endsWith('.webp')).sort();

  /**
   * A garment whose mask edit left it small in a corner of the frame, with
   * the thumb as it was made before #373 (the whole frame). Its file name.
   */
  const editedWithOldThumb = async (name: string) => {
    const garmentId = await createGarment(t, { name });
    await uploadPhoto(t, garmentId, await jpegPhoto());
    const fileName = await photoFileName(t, garmentId);
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
    const cutout = await readFile(await variantPath(t, fileName, 'nobg'));
    await writeFile(
      await variantPath(t, fileName, 'thumb'),
      await sharp(cutout).resize(400, 400, { fit: 'inside' }).webp().toBuffer(),
    );
    return fileName;
  };

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
    const fileName = await editedWithOldThumb('Framed wide');
    const cutout = await readFile(await variantPath(t, fileName, 'nobg'));
    const before = await photoRow(t, fileName);
    const filesBefore = await storedFiles();

    expect(await retrim({ dryRun: true })).toEqual({
      dryRun: true,
      stopped: false,
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
    const filesAfter = await storedFiles();
    expect(filesAfter).not.toContain(
      variantFileName(fileName, 'nobg', before!.variantKey),
    );
    expect(filesAfter).not.toContain(
      variantFileName(fileName, 'thumb', before!.variantKey),
    );
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

  it('stops between photos: the one in flight is finished, none is left half-swapped', async () => {
    const second = await editedWithOldThumb('Second');
    const third = await editedWithOldThumb('Third');
    const thirdBefore = await photoRow(t, third);

    // The signal lands while the second photo (after the first test's,
    // current) is being retrimmed, as a Ctrl-C would.
    const stop = new AbortController();
    const photos = new Proxy(t.photos, {
      get: (target, key, receiver) =>
        key === 'rederiveCutoutThumb'
          ? (...args: Parameters<Photos['rederiveCutoutThumb']>) => {
              if (args[0].fileName === second) stop.abort();
              return target.rederiveCutoutThumb(...args);
            }
          : (Reflect.get(target, key, receiver) as unknown),
    });
    expect(await retrim({ stop: stop.signal }, photos)).toMatchObject({
      stopped: true,
      photos: 2,
      current: 1,
      retrimmed: 1,
    });
    // The second's swap committed; the third was not touched.
    expect((await photoRow(t, second))!.cutoutStatus).toBe('edited');
    expect(await photoRow(t, third)).toEqual(thirdBefore);
    // Every keyed file is a row's own set: nothing for reconciliation to keep.
    const rows = await Promise.all(
      [second, third].map(async (name) => (await photoRow(t, name))!),
    );
    const keyed = (await storedFiles()).filter(
      (name) =>
        rows.some((row) =>
          name.startsWith(row.fileName.replace('.webp', '')),
        ) && /-(nobg|thumb)-/.test(name),
    );
    expect(keyed.sort()).toEqual(
      rows
        .flatMap((row) => [
          variantFileName(row.fileName, 'nobg', row.variantKey),
          variantFileName(row.fileName, 'thumb', row.variantKey),
        ])
        .sort(),
    );

    expect(await retrim()).toMatchObject({
      stopped: false,
      photos: 3,
      current: 2,
      retrimmed: 1,
    });
  });
});
