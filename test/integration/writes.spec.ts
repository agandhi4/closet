import { EntityManager } from '@mikro-orm/core';
import { readdir } from 'node:fs/promises';
import { File } from '../../src/dal/entity/file.entity';
import { Garment } from '../../src/dal/entity/garment.entity';
import { variantFileName } from '../../src/file/image-variant';
import { createGarment, jpegPhoto, uploadPhoto } from './garments';
import { createTestApp, multipart, TestApp } from './harness';

/**
 * Write correctness: a photo's bytes, its File row and the garment that
 * points at it either all exist or none of them do.
 */
describe('garment writes', () => {
  let t: TestApp;

  /** Everything under DATA_PATH except the app log. */
  const storedFiles = async () =>
    (await readdir(t.dataPath)).filter((name) => name.endsWith('.webp'));

  const photoUpload = async () =>
    multipart(
      {},
      {
        photo: {
          data: await jpegPhoto(),
          filename: 'photo.jpg',
          contentType: 'image/jpeg',
        },
      },
    );

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  afterEach(() => jest.restoreAllMocks());

  it('a rolled-back photo update leaves no File row and no files behind', async () => {
    const garmentId = await createGarment(t, { name: 'Blue shirt' });
    const filesBefore = await storedFiles();
    const rowsBefore = await t.em().count(File);

    // The transactional fork inherits EntityManager.prototype.flush; failing
    // it once fails the commit that would have inserted the File row.
    jest
      .spyOn(EntityManager.prototype, 'flush')
      .mockRejectedValueOnce(new Error('simulated flush failure'));

    const body = await photoUpload();
    const res = await t.inject({
      method: 'POST',
      url: `/wardrobe/${garmentId}/photo`,
      payload: body.payload,
      headers: body.headers,
    });
    expect(res.statusCode).toBe(500);

    expect(await t.em().count(File)).toBe(rowsBefore);
    expect(await storedFiles()).toEqual(filesBefore);
    const garment = await t
      .em()
      .findOneOrFail(Garment, garmentId, { populate: ['photo'] });
    expect(garment.photo).toBeFalsy();
  });

  it('replacing a photo removes the previous File row and its variants', async () => {
    const garmentId = await createGarment(t, { name: 'Red shirt' });
    await uploadPhoto(t, garmentId, await jpegPhoto());
    const first = (
      await t.em().findOneOrFail(Garment, garmentId, { populate: ['photo'] })
    ).photo!.fileName;

    await uploadPhoto(t, garmentId, await jpegPhoto(300, 300));
    const second = (
      await t.em().findOneOrFail(Garment, garmentId, { populate: ['photo'] })
    ).photo!.fileName;
    expect(second).not.toBe(first);

    expect(await t.em().findOne(File, { fileName: first })).toBeNull();
    expect(await t.em().findOne(File, { fileName: second })).not.toBeNull();
    const files = await storedFiles();
    expect(files).not.toContain(first);
    expect(files).not.toContain(variantFileName(first, 'thumb'));
    expect(files).toContain(second);
    expect(files).toContain(variantFileName(second, 'thumb'));
  });

  it('deleting a garment removes its File row and every variant file', async () => {
    const garmentId = await createGarment(t, { name: 'Green shirt' });
    await uploadPhoto(t, garmentId, await jpegPhoto());
    const fileName = (
      await t.em().findOneOrFail(Garment, garmentId, { populate: ['photo'] })
    ).photo!.fileName;
    expect(await storedFiles()).toEqual(
      expect.arrayContaining([fileName, variantFileName(fileName, 'thumb')]),
    );

    const res = await t.inject({
      method: 'DELETE',
      url: `/wardrobe/${garmentId}`,
    });
    expect(res.statusCode).toBe(200);

    expect(await t.em().findOne(Garment, garmentId)).toBeNull();
    expect(await t.em().findOne(File, { fileName })).toBeNull();
    const files = await storedFiles();
    expect(files).not.toContain(fileName);
    expect(files).not.toContain(variantFileName(fileName, 'thumb'));
    expect(files).not.toContain(variantFileName(fileName, 'nobg'));
  });

  it('a corrupted upload is a 400 and leaves no partial file on disk', async () => {
    const garmentId = await createGarment(t, { name: 'Corrupt' });
    const filesBefore = await storedFiles();
    const rowsBefore = await t.em().count(File);

    const body = await multipart(
      {},
      {
        photo: {
          data: Buffer.from('definitely not a jpeg'),
          filename: 'photo.jpg',
          contentType: 'image/jpeg',
        },
      },
    );
    const res = await t.inject({
      method: 'POST',
      url: `/wardrobe/${garmentId}/photo`,
      payload: body.payload,
      headers: body.headers,
    });
    expect(res.statusCode).toBe(400);

    expect(await storedFiles()).toEqual(filesBefore);
    expect(await t.em().count(File)).toBe(rowsBefore);
  });

  it('cloning a garment with a photo commits the copied File row with the clone', async () => {
    const sourceId = await createGarment(t, { name: 'Source' });
    await uploadPhoto(t, sourceId, await jpegPhoto());

    const res = await t.inject({
      method: 'POST',
      url: `/wardrobe/${sourceId}/clone`,
      payload: { name: 'Copy', category: 'shirt' },
    });
    expect(res.statusCode).toBe(302);
    const cloneId = Number(
      /^\/wardrobe\/(\d+)$/.exec(res.headers.location as string)![1],
    );

    const clone = await t
      .em()
      .findOneOrFail(Garment, cloneId, { populate: ['photo'] });
    expect(clone.photo?.shareableId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await storedFiles()).toContain(clone.photo!.fileName);
  });
});
