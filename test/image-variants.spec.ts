import { test, expect } from '@playwright/test';
import sharp from 'sharp';

/**
 * Every garment photo is served as three immutable WebP variants addressed
 * by /file/{,nobg/,thumb/}<fileName>?v=<version>. The wardrobe grid must use
 * the thumb variant and the server must answer it with long-lived cache
 * headers, otherwise the grid re-downloads full-size images on every visit.
 */
test('wardrobe grid uses versioned thumb URLs served as immutable webp', async ({
  page,
}) => {
  const email = `image-test-${Date.now()}@example.com`;
  const password = 'Password123!';
  // No-op when AUTH_ENABLED=false; establishes a session otherwise.
  await page.request.post('/auth/register', {
    form: { email, password, confirmPassword: password },
  });

  const name = `Image Variant Garment ${Date.now()}`;
  const photo = await sharp({
    create: { width: 1600, height: 1200, channels: 3, background: '#4a6' },
  })
    .jpeg()
    .toBuffer();

  // Same two requests the garment form issues: create, then upload the photo.
  const createResponse = await page.request.post('/wardrobe', {
    form: { name, category: 'shirt' },
  });
  expect(createResponse.ok()).toBe(true);
  const garmentId = new URL(createResponse.url()).pathname.split('/').pop();
  const photoResponse = await page.request.post(
    `/wardrobe/${garmentId}/photo`,
    {
      multipart: {
        photo: { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: photo },
      },
    },
  );
  expect(photoResponse.ok()).toBe(true);

  await page.goto('/wardrobe');
  const tile = page.locator('img[alt="' + name + '"]');
  await expect(tile).toBeVisible();
  const src = await tile.getAttribute('src');
  expect(src).toMatch(/^\/file\/thumb\/[0-9a-f-]+\.webp\?v=1$/);

  for (const variant of ['thumb', 'nobg', 'original']) {
    const url =
      variant === 'original'
        ? src!.replace('/file/thumb/', '/file/')
        : src!.replace('/file/thumb/', `/file/${variant}/`);
    const response = await page.request.get(url);
    expect(response.status(), url).toBe(200);
    expect(response.headers()['content-type'], url).toBe('image/webp');
    expect(response.headers()['cache-control'], url).toBe(
      'public, max-age=31536000, immutable',
    );
    const meta = await sharp(await response.body()).metadata();
    expect(meta.format, url).toBe('webp');
    if (variant === 'thumb') {
      expect(meta.width).toBeLessThanOrEqual(400);
      expect(meta.height).toBeLessThanOrEqual(400);
    }
  }

  const bogus = await page.request.get(
    src!.replace('/file/thumb/', '/file/../'),
  );
  expect(bogus.status()).not.toBe(200);
});
