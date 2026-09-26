import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { Garment } from '../../src/dal/entity/garment.entity';
import { variantFileName } from '../../src/file/image-variant';
import { createGarment, jpegPhoto, uploadPhoto } from './garments';
import { createTestApp, imgTags, TestApp } from './harness';

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

describe('wardrobe', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  it('GET / redirects to the wardrobe', async () => {
    const res = await t.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/wardrobe');
  });

  describe('garment photo lifecycle', () => {
    // Sequential: each step builds on the garment the previous one made.
    let garmentId: number;
    let fileName: string;
    const filePath = (variant: 'original' | 'nobg' | 'thumb') =>
      join(t.dataPath, variantFileName(fileName, variant));

    it('stores a File row plus original and thumb variants on upload', async () => {
      garmentId = await createGarment(t, { name: 'Green shirt' });
      await uploadPhoto(t, garmentId, await jpegPhoto(1200, 800));

      const garment = await t
        .em()
        .findOneOrFail(Garment, garmentId, { populate: ['photo'] });
      expect(garment.photo?.fileName).toMatch(/^[0-9a-f-]{36}\.webp$/);
      expect(garment.photo?.version).toBe(1);
      fileName = garment.photo!.fileName;

      const original = await sharp(filePath('original')).metadata();
      expect(original.format).toBe('webp');
      expect(original.width).toBe(1080);

      const thumb = await sharp(filePath('thumb')).metadata();
      expect(thumb.format).toBe('webp');
      expect(Math.max(thumb.width, thumb.height)).toBeLessThanOrEqual(400);

      expect(await exists(filePath('nobg'))).toBe(false);
    });

    it('renders the grid with versioned thumbs, eager above the fold and lazy below', async () => {
      const thumbUrl = `/file/thumb/${fileName}?v=1`;
      const tileFor = (html: string) =>
        imgTags(html).find((tag) => tag.includes(`src="${thumbUrl}"`));

      const first = await t.inject({ method: 'GET', url: '/wardrobe' });
      expect(first.statusCode).toBe(200);
      const eager = tileFor(first.body);
      expect(eager).toBeDefined();
      expect(eager).toContain('width="400"');
      expect(eager).toContain('height="400"');
      expect(eager).not.toContain('loading="lazy"');

      // Newest first: eight newer garments push the photo to index 8.
      for (let i = 0; i < 8; i++) {
        await createGarment(t, { name: `Filler ${i}` });
      }
      const second = await t.inject({ method: 'GET', url: '/wardrobe' });
      const lazy = tileFor(second.body);
      expect(lazy).toBeDefined();
      expect(lazy).toContain('loading="lazy"');
    });

    it('serves the thumb as immutable webp', async () => {
      const res = await t.inject({
        method: 'GET',
        url: `/file/thumb/${fileName}?v=1`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/webp');
      expect(res.headers['cache-control']).toBe(
        'public, max-age=31536000, immutable',
      );
      expect(res.rawPayload.equals(await readFile(filePath('thumb')))).toBe(
        true,
      );
    });

    it('falls back to the original when no cutout exists', async () => {
      const res = await t.inject({
        method: 'GET',
        url: `/file/nobg/${fileName}?v=1`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/webp');
      expect(res.rawPayload.equals(await readFile(filePath('original')))).toBe(
        true,
      );
    });

    it('DELETE removes the row and every variant file', async () => {
      const res = await t.inject({
        method: 'DELETE',
        url: `/wardrobe/${garmentId}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['hx-redirect']).toBe('/wardrobe');

      expect(await t.em().findOne(Garment, garmentId)).toBeNull();
      expect(await exists(filePath('original'))).toBe(false);
      expect(await exists(filePath('thumb'))).toBe(false);

      const gone = await t.inject({
        method: 'GET',
        url: `/file/thumb/${fileName}?v=1`,
      });
      expect(gone.statusCode).toBe(404);
    });
  });
});
