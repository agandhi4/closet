import { expect, type Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { SAME_ORIGIN, signIn } from './support/e2e-session';

/**
 * The phone downscales a picked photo before upload (public/js/
 * photo-input.js): to 1600 px on its long side as a JPEG, or unchanged when
 * it is small or the browser cannot decode it (HEIC in Chromium; the server
 * decodes it).
 */

const bigPhoto = () =>
  sharp({
    create: { width: 4000, height: 3000, channels: 3, background: '#468' },
  })
    .jpeg()
    .toBuffer();

async function openGarment(page: Page) {
  await signIn(page, 'downscale');
  const created = await page.request.post('/wardrobe', {
    form: { name: 'Downscaled shirt', category: 'shirt' },
    headers: SAME_ORIGIN,
  });
  const id = new URL(created.url()).pathname.split('/').pop();
  await page.goto(`/wardrobe/${id}`);
}

/** The file the form will upload, once the submit button allows it. */
async function chosenFile(page: Page) {
  await expect(page.locator('#photoBtn')).toBeEnabled();
  return page.locator('#photoInput').evaluate(async (input) => {
    const file = (input as HTMLInputElement).files![0];
    const bitmap = await createImageBitmap(file).catch(() => undefined);
    return {
      name: file.name,
      type: file.type,
      width: bitmap?.width,
      height: bitmap?.height,
    };
  });
}

test.beforeEach(async ({ page }) => {
  await openGarment(page);
});

test('a large photo goes up as a 1600 px JPEG', async ({ page }) => {
  await page.locator('#photoInput').setInputFiles({
    name: 'IMG_0001.jpeg',
    mimeType: 'image/jpeg',
    buffer: await bigPhoto(),
  });
  expect(await chosenFile(page)).toEqual({
    name: 'IMG_0001.jpg',
    type: 'image/jpeg',
    width: 1600,
    height: 1200,
  });
});

test('a photo the browser cannot decode goes up as it is', async ({ page }) => {
  await page.locator('#photoInput').setInputFiles({
    name: 'IMG_0002.heic',
    mimeType: 'image/heic',
    buffer: readFileSync(path.join(__dirname, 'fixtures', 'example.heic')),
  });
  expect(await chosenFile(page)).toMatchObject({
    name: 'IMG_0002.heic',
    type: 'image/heic',
  });
});
