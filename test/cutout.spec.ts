import { expect } from '@playwright/test';
import sharp from 'sharp';
import { test } from './support/cutout-hold';
import { SAME_ORIGIN, signIn } from './support/e2e-session';
import { openPhotoSheet } from './support/garment-page';

/**
 * A garment photo in a browser, against the test server (its model stubbed,
 * the cutout held pending until the spec has seen it:
 * test/support/cutout-stub.ts): the photo sheet uploads the photo it is
 * given, the page shows the cutout pending, the polling fragment swaps the
 * cutout in, and the pencil that arrives with it edits it
 * (public/js/mask-editor.js), saving a new photo version.
 */
test('an uploaded photo shows "Removing background", then its cutout, which the pencil edits', async ({
  page,
  cutouts,
}) => {
  // The mask editor draws from blob: URLs; the CSP must still allow that.
  const cspViolations: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy/i.test(message.text())) {
      cspViolations.push(message.text());
    }
  });

  const email = await signIn(page, 'cutout');
  await cutouts.hold(email);
  const created = await page.request.post('/wardrobe', {
    form: { name: 'Cutout shirt', category: 'shirt' },
    headers: SAME_ORIGIN,
  });
  expect(created.ok()).toBe(true);
  const garmentId = new URL(created.url()).pathname.split('/').pop();

  await page.goto(`/wardrobe/${garmentId}`);
  await openPhotoSheet(page);
  await page.locator('#photoInput').setInputFiles({
    name: 'shirt.jpg',
    mimeType: 'image/jpeg',
    buffer: await sharp({
      create: { width: 900, height: 1200, channels: 3, background: '#a33' },
    })
      .jpeg()
      .toBuffer(),
  });

  const photo = page.locator('#garment-photo');
  await expect(page.locator('#garment-photo-status')).toHaveText(
    /Removing background/,
  );
  await expect(photo.locator('img')).toHaveAttribute(
    'src',
    /\?v=1&s=[\w-]{16}$/,
  );
  await expect(page.locator('#editMaskBtn')).toHaveCount(0);

  // Released, the stub answers at once; the page polls every 2 s.
  await cutouts.release(email);
  await expect(photo.locator('img')).toHaveAttribute(
    'src',
    /^\/file\/nobg\/[0-9a-f-]+\.webp\?v=2&k=[0-9a-f]{12}&s=[\w-]{16}$/,
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
  await expect(photo.locator('img')).toHaveAttribute(
    'src',
    /\?v=3&k=[0-9a-f]{12}&s=[\w-]{16}$/,
  );
  await expect(page.locator('#editMaskBtn')).toHaveAttribute(
    'data-nobg-url',
    /\?v=3&k=[0-9a-f]{12}&s=[\w-]{16}$/,
  );
  expect(cspViolations).toEqual([]);
});

/**
 * A photo the server refuses is shown, not swallowed: the sheet posts
 * natively, so the refusal is the error page. It used to be an htmx post,
 * whose 4xx htmx dropped: the sheet sat there as if nothing had happened.
 */
test.describe('at phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('a file that is not a photo shows the refusal', async ({ page }) => {
    await signIn(page, 'cutout-refused');
    const created = await page.request.post('/wardrobe', {
      form: { name: 'Refused shirt', category: 'shirt' },
      headers: SAME_ORIGIN,
    });
    expect(created.ok()).toBe(true);
    const garmentId = new URL(created.url()).pathname.split('/').pop();

    await page.goto(`/wardrobe/${garmentId}`);
    await openPhotoSheet(page);
    await page.locator('#photoInput').setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('not a photo'),
    });

    await expect(page.getByText('Wrong filetype')).toBeVisible();
    await expect(page.locator('.app-bar')).toContainText('Error 400');
  });
});
