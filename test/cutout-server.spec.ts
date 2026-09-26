import { expect, test } from '@playwright/test';
import sharp from 'sharp';
import { signIn } from './support/e2e-session';

/**
 * CUTOUT_MODE=server in a browser, against test/support/cutout-stub-server.ts
 * (:3001, the model stubbed): the photo form uploads the photo alone and
 * never loads the in-browser model, the page shows the cutout pending, and
 * the polling fragment swaps the cutout in. Client mode is every other spec.
 */
const STUB_ORIGIN = 'http://localhost:3001';

test.use({ baseURL: STUB_ORIGIN });

test('an uploaded photo shows "Removing background" and then its cutout', async ({
  page,
}) => {
  await signIn(page, 'cutout-server', STUB_ORIGIN);
  const created = await page.request.post('/wardrobe', {
    form: { name: 'Server cutout shirt', category: 'shirt' },
    headers: { origin: STUB_ORIGIN },
  });
  expect(created.ok()).toBe(true);
  const garmentId = new URL(created.url()).pathname.split('/').pop();

  const modelRequests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (
      url.pathname.startsWith('/bg-removal-models/') ||
      url.pathname.startsWith('/modules/background-removal/') ||
      url.pathname.startsWith('/modules/onnxruntime-web/')
    ) {
      modelRequests.push(url.pathname);
    }
  });

  await page.goto(`/wardrobe/${garmentId}`);
  await expect(page.locator('#bgRemovalToggle')).toHaveCount(0);
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
  expect(modelRequests).toEqual([]);

  // The pencil swapped in with the cutout edits it: its URLs come from the
  // new button, and the save names the new version.
  await page.locator('#editMaskBtn').click();
  await expect(page.locator('#maskEditorDialog')).toBeVisible();
  await page.locator('#maskEditorAccept').click();
  await expect(photo.locator('img')).toHaveAttribute('src', /\?v=3$/);
});
