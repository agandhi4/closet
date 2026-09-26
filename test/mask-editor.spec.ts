import { expect, test } from '@playwright/test';
import sharp from 'sharp';
import { SAME_ORIGIN, signIn } from './support/e2e-session';

/**
 * The pencil on a garment photo (client mode, the default server): it
 * opens the mask editor on the stored cutout and saves the edit as a new
 * photo version, which the page then shows (public/js/mask-editor.js).
 */
test('the pencil edits the stored cutout and shows the new version', async ({
  page,
}) => {
  await signIn(page, 'mask-editor');
  const created = await page.request.post('/wardrobe', {
    form: { name: 'Mask editor shirt', category: 'shirt' },
    headers: SAME_ORIGIN,
  });
  const garmentId = new URL(created.url()).pathname.split('/').pop();
  const uploaded = await page.request.post(`/wardrobe/${garmentId}/photo`, {
    multipart: {
      photo: {
        name: 'photo.jpg',
        mimeType: 'image/jpeg',
        buffer: await sharp({
          create: { width: 800, height: 600, channels: 3, background: '#36a' },
        })
          .jpeg()
          .toBuffer(),
      },
    },
    headers: SAME_ORIGIN,
  });
  expect(uploaded.ok()).toBe(true);

  await page.goto(`/wardrobe/${garmentId}`);
  const image = page.locator('#garment-photo img');
  await expect(image).toHaveAttribute('src', /\?v=1$/);

  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/wardrobe/${garmentId}/nobg`) &&
      response.request().method() === 'POST',
  );
  await page.locator('#editMaskBtn').click();
  await expect(page.locator('#maskEditorDialog')).toBeVisible();
  await page.locator('#maskEditorAccept').click();

  expect((await saved).status()).toBe(200);
  await expect(image).toHaveAttribute('src', /\?v=2$/);
  await expect(page.locator('#editMaskBtn')).toHaveAttribute(
    'data-nobg-url',
    /\?v=2$/,
  );
});
