import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import sharp from 'sharp';
import { createGarment } from './support/e2e-data';
import { SAME_ORIGIN, signIn } from './support/e2e-session';

/**
 * The year in review in a browser at phone width (#26): opened from the
 * Wardrobe's ⋯ menu (the dock stays on Wardrobe), laid out without
 * sideways scrolling, and "Save image" drawing the card
 * (public/js/recap-export.js) from the page's fonts, theme and a garment's
 * photo into a 1080 × 1350 PNG. Chromium on Linux cannot share files, so
 * the tap downloads it, which is what this reads back; the share sheet is
 * the same File. The figures themselves are
 * test/integration/recap.spec.ts's.
 */

test.use({ viewport: { width: 390, height: 844 } });

const COLOURS = ['white', 'blue', 'black', 'green', 'grey'];

/**
 * The PNG's corner pixel: the card's background, closet-light's page colour
 * (#faf8f4 in src/web/theme-colors.ts, which is main.css's oklch as hex),
 * within the canvas's rounding of the oklch token.
 */
async function expectLightCard(png: Buffer): Promise<void> {
  const { data } = await sharp(png)
    .extract({ left: 4, top: 4, width: 1, height: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const [r, g, b] = data;
  for (const [channel, expected] of [
    [r, 0xfa],
    [g, 0xf8],
    [b, 0xf4],
  ]) {
    expect(Math.abs(channel - expected)).toBeLessThanOrEqual(2);
  }
}

test('the year in review on the phone, saved as an image', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await signIn(page, 'recap');

  // Ten pieces worn today: a recap in any week of the year, January 1
  // included (a recap needs ten wears).
  const ids: number[] = [];
  for (let i = 0; i < 10; i += 1) {
    ids.push(
      await createGarment(page, `Piece ${i + 1} with a long name`, 'tops', {
        product: '1',
        color: COLOURS[i % COLOURS.length],
        price: String(20 + i * 10),
      }),
    );
  }
  const photo = await sharp({
    create: { width: 800, height: 1000, channels: 3, background: '#4a6' },
  })
    .jpeg()
    .toBuffer();
  const uploaded = await page.request.post(`/wardrobe/${ids[0]}/photo`, {
    multipart: {
      photo: { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: photo },
    },
    headers: SAME_ORIGIN,
  });
  expect(uploaded.ok()).toBe(true);
  for (const id of ids) {
    const wore = await page.request.post(`/wardrobe/${id}/wear`, {
      form: { worn: '1' },
      headers: SAME_ORIGIN,
    });
    expect(wore.ok()).toBe(true);
  }

  await page.goto('/wardrobe');
  await page.getByLabel('More', { exact: true }).click();
  await page
    .locator('#wardrobe-menu')
    .getByRole('link', { name: 'Year in review' })
    .click();
  await expect(page).toHaveURL(/\/wardrobe\/recap$/);
  await expect(page.locator('.dock a[aria-current="page"]')).toHaveAttribute(
    'href',
    '/wardrobe',
  );
  await expect(
    page.locator('#recap-summary [data-stat="wears"]'),
  ).toContainText('10');
  await expect(page.locator('#recap-most-worn li')).toHaveCount(5);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);

  // Enabled once the PNG is drawn; the tap downloads it here.
  const save = page.locator('#recap-export');
  await expect(save).toBeEnabled();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    save.click(),
  ]);
  const year = await page.locator('#recap').getAttribute('data-year');
  expect(download.suggestedFilename()).toBe(`closet-${year}.png`);
  const png = await readFile(await download.path());
  const meta = await sharp(png).metadata();
  expect([meta.format, meta.width, meta.height]).toEqual(['png', 1080, 1350]);
  await test.info().attach('recap.png', {
    body: png,
    contentType: 'image/png',
  });

  await expectLightCard(png);
  expect(errors).toEqual([]);
});

test.describe('in dark mode', () => {
  test.use({ colorScheme: 'dark' });

  test('the image is still the light card', async ({ page }) => {
    // The page itself is dark: the card must not follow it.
    await signIn(page, 'recap-dark');
    for (let i = 0; i < 10; i += 1) {
      const id = await createGarment(page, `Dark piece ${i + 1}`, 'tops');
      const wore = await page.request.post(`/wardrobe/${id}/wear`, {
        form: { worn: '1' },
        headers: SAME_ORIGIN,
      });
      expect(wore.ok()).toBe(true);
    }
    await page.goto('/wardrobe/recap');
    const save = page.locator('#recap-export');
    await expect(save).toBeEnabled();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      save.click(),
    ]);
    await expectLightCard(await readFile(await download.path()));
  });
});

test('a card that cannot be drawn says so, and a tap tries again', async ({
  page,
}) => {
  // The canvas refuses to encode (toBlob answers null) until the flag drops.
  await page.addInitScript(() => {
    const flags = window as unknown as { failRecapPng: boolean };
    flags.failRecapPng = true;
    // The descriptor's value, called with the canvas as `this` below.
    const toBlob = Object.getOwnPropertyDescriptor(
      HTMLCanvasElement.prototype,
      'toBlob',
    )!.value as HTMLCanvasElement['toBlob'];
    HTMLCanvasElement.prototype.toBlob = function (callback, ...rest) {
      if (flags.failRecapPng) callback(null);
      else toBlob.call(this, callback, ...rest);
    };
  });
  await signIn(page, 'recap-fail');
  for (let i = 0; i < 10; i += 1) {
    const id = await createGarment(page, `Failing piece ${i + 1}`, 'tops');
    const wore = await page.request.post(`/wardrobe/${id}/wear`, {
      form: { worn: '1' },
      headers: SAME_ORIGIN,
    });
    expect(wore.ok()).toBe(true);
  }
  await page.goto('/wardrobe/recap');

  // The failure is on screen (not a title, which a phone never shows), read
  // out, and the button stays usable.
  const note = page.locator('#recap-export-note');
  await expect(note).toHaveText(
    'The image could not be drawn. Tap Save image to try again.',
  );
  await expect(note).toHaveAttribute('aria-live', 'polite');
  await expect(note).toHaveClass(/text-error/);
  const save = page.locator('#recap-export');
  await expect(save).toBeEnabled();

  // Once drawing works, a tap draws the card again and the next one saves it.
  await page.evaluate(() => {
    (window as unknown as { failRecapPng: boolean }).failRecapPng = false;
  });
  await save.click();
  await expect(note).not.toHaveClass(/text-error/);
  await expect(save).toBeEnabled();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    save.click(),
  ]);
  await expectLightCard(await readFile(await download.path()));
});
