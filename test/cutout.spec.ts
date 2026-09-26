import { expect, test } from '@playwright/test';
import sharp from 'sharp';
import { SAME_ORIGIN, signIn } from './support/e2e-session';

/**
 * A garment photo in a browser, against the test server (its model stubbed
 * to answer in 3 s, test/support/test-server.ts): the form uploads the
 * photo, the page shows the cutout pending, the polling fragment swaps the
 * cutout in, and the pencil that arrives with it edits it
 * (public/js/mask-editor.js), saving a new photo version.
 */
test('an uploaded photo shows "Removing background", then its cutout, which the pencil edits', async ({
  page,
}) => {
  // The mask editor draws from blob: URLs; the CSP must still allow that.
  const cspViolations: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy/i.test(message.text())) {
      cspViolations.push(message.text());
    }
  });

  await signIn(page, 'cutout');
  const created = await page.request.post('/wardrobe', {
    form: { name: 'Cutout shirt', category: 'shirt' },
    headers: SAME_ORIGIN,
  });
  expect(created.ok()).toBe(true);
  const garmentId = new URL(created.url()).pathname.split('/').pop();

  await page.goto(`/wardrobe/${garmentId}`);
  await page.locator('#photoInput').setInputFiles({
    name: 'shirt.jpg',
    mimeType: 'image/jpeg',
    buffer: await sharp({
      create: { width: 900, height: 1200, channels: 3, background: '#a33' },
    })
      .jpeg()
      .toBuffer(),
  });
  await expect(page.locator('#photoBtn')).toBeEnabled();
  await page.locator('#photoBtn').click();

  const photo = page.locator('#garment-photo');
  await expect(page.locator('#garment-photo-status')).toHaveText(
    /Removing background/,
  );
  await expect(photo.locator('img')).toHaveAttribute('src', /\?v=1$/);
  await expect(page.locator('#editMaskBtn')).toHaveCount(0);

  // The stub answers after 3 s; the page polls every 2 s.
  await expect(photo.locator('img')).toHaveAttribute(
    'src',
    /^\/file\/nobg\/[0-9a-f-]+\.webp\?v=2$/,
    { timeout: 15_000 },
  );
  await expect(page.locator('#garment-photo-status')).toHaveCount(0);

  // The pencil swapped in with the cutout edits it: its URLs come from the
  // new button, and the save names the new version.
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/wardrobe/${garmentId}/nobg`) &&
      response.request().method() === 'POST',
  );
  await page.locator('#editMaskBtn').click();
  await expect(page.locator('#maskEditorDialog')).toBeVisible();
  await page.locator('#maskEditorAccept').click();
  expect((await saved).status()).toBe(200);
  await expect(photo.locator('img')).toHaveAttribute('src', /\?v=3$/);
  await expect(page.locator('#editMaskBtn')).toHaveAttribute(
    'data-nobg-url',
    /\?v=3$/,
  );
  expect(cspViolations).toEqual([]);
});
