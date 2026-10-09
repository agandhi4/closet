import { expect, type Page, test } from '@playwright/test';
import sharp from 'sharp';
import { SAME_ORIGIN, signIn } from './support/e2e-session';
import { householdToday } from './support/household-today';
import { pageErrors } from './support/page-errors';

/**
 * Outfit selfies (#19) at phone width, as the installed app takes them:
 * the camera button on Today's card (a file input with
 * capture="environment": on a phone it opens the rear camera for the
 * mirror; Playwright sets the file the camera would give), the photo
 * downscaled on the phone and posted, the entry worn, and the look shown on
 * Today, the calendar and the outfit's Worn strip through the owner-only
 * /selfies/ route; then removed from its dialog. The server side is
 * test/integration/selfies.spec.ts.
 *
 * The camera itself only a phone can open: on an iPhone and an Android
 * phone, installed, tap the camera on Today's card and check the rear
 * camera opens (not the library), a mirror photo comes back to Today worn,
 * and an iPhone's HEIC shows once taken.
 */

test.use({ viewport: { width: 390, height: 844 } });

/** A POST whose redirect names the new row; its id. */
async function created(
  page: Page,
  url: string,
  form: Record<string, string>,
  pattern: RegExp,
): Promise<number> {
  const res = await page.request.post(url, {
    form,
    headers: SAME_ORIGIN,
    maxRedirects: 0,
  });
  expect(res.status()).toBe(302);
  return Number(pattern.exec(res.headers().location ?? '')?.[1]);
}

/** A 12 MP portrait photo, as a phone's camera hands it over. */
function cameraPhoto(): Promise<Buffer> {
  return sharp({
    create: {
      width: 3000,
      height: 4000,
      channels: 3,
      background: '#a58d74',
    },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

test('take a mirror selfie from Today, see the look everywhere, then remove it', async ({
  page,
}) => {
  const errors = pageErrors(page);
  const uploads: number[] = [];
  page.on('request', (request) => {
    if (/\/calendar\/\d+\/selfie/.test(request.url())) {
      uploads.push(request.postDataBuffer()?.length ?? 0);
    }
  });
  await signIn(page, 'selfies');
  const shirt = await created(
    page,
    '/wardrobe',
    { name: 'Linen shirt', category: 'tops' },
    /^\/wardrobe\/(\d+)\?/,
  );
  const outfit = await created(
    page,
    '/outfits',
    { name: 'Dinner', category: 'tops', garmentId: String(shirt) },
    /^\/outfits\/(\d+)$/,
  );
  const scheduled = await page.request.post('/calendar', {
    form: { date: householdToday(), outfitId: String(outfit) },
    headers: SAME_ORIGIN,
  });
  expect(scheduled.ok()).toBe(true);

  // Today's card offers the camera (rear, for the mirror) and the library.
  await page.goto('/');
  const card = page.locator('[data-today-row="planned"] article');
  const camera = card.getByLabel('Take a selfie');
  await expect(camera).toHaveAttribute('capture', 'environment');
  await expect(camera).toHaveAttribute('accept', 'image/*');
  await expect(card.getByLabel('Choose a photo')).not.toHaveAttribute(
    'capture',
  );

  // Choosing the photo is enough: it is downscaled and posted, and Today
  // comes back with the entry worn and the look on it.
  await camera.setInputFiles({
    name: 'IMG_0001.jpg',
    mimeType: 'image/jpeg',
    buffer: await cameraPhoto(),
  });
  await expect(page).toHaveURL(/\/$/);
  const thumb = card.locator('img[src^="/selfies/thumb/"]');
  await expect(thumb).toBeVisible();
  await expect
    .poll(() => thumb.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  await expect(card.getByText('✓ Worn', { exact: true })).toBeVisible();
  // The phone sent its 1600 px copy, not the 12 MP original.
  expect(uploads).toHaveLength(1);
  expect(uploads[0]).toBeLessThan(400_000);

  // The calendar's row shows it; tapping opens the whole photo.
  await page.goto('/calendar');
  const row = page.locator('[data-occasion="all-day"]', {
    has: page.locator('img[src^="/selfies/thumb/"]'),
  });
  await row.locator('button[data-selfie]').click();
  const dialog = page.locator('dialog[open]');
  const full = dialog.locator('img[src^="/selfies/"]');
  await expect(full).toBeVisible();
  await expect
    .poll(() => full.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  await dialog.getByRole('button', { name: 'Close' }).first().click();
  await expect(page.locator('dialog[open]')).toHaveCount(0);

  // The outfit's Worn strip, by date.
  await page.goto(`/outfits/${outfit}`);
  const strip = page.locator('[data-worn-strip]');
  await expect(strip.getByRole('heading', { name: 'Worn (1)' })).toBeVisible();
  await expect(
    strip.locator(`[data-worn-day="${householdToday()}"] button img`),
  ).toBeVisible();

  // Removed from its dialog (after the confirm): the entry stays worn and
  // the camera is back.
  page.once('dialog', (confirm) => void confirm.accept());
  await strip.locator('button[data-selfie]').click();
  await page
    .locator('dialog[open]')
    .getByRole('button', { name: 'Remove photo' })
    .click();
  await expect(page).toHaveURL(new RegExp(`/outfits/${outfit}$`));
  await expect(page.locator('img[src^="/selfies/"]')).toHaveCount(0);
  await expect(
    page.locator('[data-worn-strip]').getByLabel('Take a selfie'),
  ).toBeAttached();

  expect(errors).toEqual([]);
});
