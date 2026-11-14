import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { imageUrl } from '../../src/web/files/image-url';
import { readPhotoRef } from '../../src/web/files/queries';
import { variantFileName } from '../../src/web/files/image-variant';
import { createGarment, garmentRow, jpegPhoto, uploadPhoto } from './garments';
import {
  createTestApp,
  hxLocationPath,
  imgTags,
  TestApp,
  unescapeHtml,
} from './harness';

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

  describe('garment photo lifecycle', () => {
    // Sequential: each step builds on the garment the previous one made.
    let garmentId: number;
    let fileName: string;
    const filePath = (variant: 'original' | 'nobg' | 'thumb') =>
      join(t.dataPath, variantFileName(fileName, variant));

    it('stores a File row plus original and thumb variants on upload', async () => {
      garmentId = await createGarment(t, { name: 'Green shirt' });
      await uploadPhoto(t, garmentId, await jpegPhoto(1200, 800));

      const garment = (await garmentRow(t, garmentId))!;
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
      // The URL a page renders: signed (#162).
      const thumbUrl = imageUrl(
        readPhotoRef({ fileName, version: 1, variantKey: null }),
        'thumb',
      );
      const tileFor = (html: string) =>
        imgTags(unescapeHtml(html)).find((tag) =>
          tag.includes(`src="${thumbUrl}"`),
        );

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
        'private, max-age=31536000, immutable',
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
      expect(hxLocationPath(res)).toBe('/wardrobe');

      expect(await garmentRow(t, garmentId)).toBeUndefined();
      expect(await exists(filePath('original'))).toBe(false);
      expect(await exists(filePath('thumb'))).toBe(false);

      const gone = await t.inject({
        method: 'GET',
        url: `/file/thumb/${fileName}?v=1`,
      });
      expect(gone.statusCode).toBe(404);
    });
  });

  describe('the filter sheet (#674)', () => {
    const sheet = async (query = '') => {
      const res = await t.inject({ method: 'GET', url: `/wardrobe${query}` });
      expect(res.statusCode).toBe(200);
      const html = unescapeHtml(res.body);
      return html.slice(html.indexOf('<dialog id="filter-modal"'));
    };

    beforeAll(async () => {
      const res = await t.inject({
        method: 'POST',
        url: '/wardrobe',
        payload: {
          name: 'Typed shirt',
          category: 'tops',
          props: '1',
          type: 'shirt',
          color: 'blue',
        },
      });
      expect(res.statusCode).toBe(302);
    });

    it('is named by its heading, and every chip is a focusable input with a name', async () => {
      const html = await sheet();
      expect(html).toContain('aria-labelledby="filter-modal-title"');
      expect(html).toContain('id="filter-modal-title"');
      const chips = [
        ...html.matchAll(/<input\b[^>]*name="(category|color|type)"[^>]*>/g),
      ];
      expect(chips.length).toBeGreaterThan(10);
      for (const [chip] of chips) {
        expect(chip).toContain('type="radio"');
        expect(chip).toMatch(/aria-label="[^"]+"/);
        expect(chip).not.toMatch(/class="[^"]*\bhidden\b/);
      }
    });

    it('renders the type chips before any category is applied, revealed by the chosen category', async () => {
      const html = await sheet();
      expect(html).toContain('id="filter-type-tops-title"');
      expect(html).toMatch(/<input[^>]*name="type"[^>]*value="shirt"[^>]*>/);
      expect(html).toContain(
        'group-has-[input[name=category][value=tops]:checked]/filter:block',
      );
    });

    it('offers a clear chip only beside a chosen value, and keeps the chosen one checked', async () => {
      const plain = await sheet();
      expect(plain).not.toContain('value=""');
      const chosen = await sheet('?category=tops&type=shirt&color=blue');
      expect(chosen.match(/<input[^>]*value=""[^>]*>/g)).toHaveLength(3);
      expect(chosen).toMatch(
        /<input[^>]*name="type"[^>]*value="shirt"[^>]*checked/,
      );
    });
  });
});
