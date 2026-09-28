import { expect, type Page, test } from '@playwright/test';
import sharp from 'sharp';
import { SAME_ORIGIN, signIn } from './support/e2e-session';
import { openPhotoSheet } from './support/garment-page';

/**
 * Rotate ↺ / ↻ in the garment page's photo sheet at phone width (#199): a
 * tap posts once, the page comes back with the turned photo (a new file,
 * its cutout pending again) and the sheet open again, so the next quarter
 * turn is one more tap.
 */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

/** 1200x800, red on the left half and blue on the right. */
function twoTone(): Promise<Buffer> {
  return sharp({
    create: { width: 1200, height: 800, channels: 3, background: '#00f' },
  })
    .composite([
      {
        input: {
          create: {
            width: 600,
            height: 800,
            channels: 3,
            background: '#f00',
          },
        },
        left: 0,
        top: 0,
      },
    ])
    .jpeg()
    .toBuffer();
}

/** The hero's original, as stored: its size and whether x, y is red. */
async function heroOriginal(page: Page, src: string) {
  const response = await page.request.get(src.replace('/file/nobg/', '/file/'));
  const bytes = await response.body();
  const { data, info } = await sharp(bytes)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    size: [info.width, info.height],
    redAt: (x: number, y: number) => {
      const offset = (y * info.width + x) * info.channels;
      return data[offset] > data[offset + 2];
    },
  };
}

test('two taps on ↻ in the photo sheet turn the photo 180° at 390 px', async ({
  page,
}) => {
  await signIn(page, 'rotate-test');
  const created = await page.request.post('/wardrobe', {
    form: { name: 'Sideways Tee', category: 'shirt' },
    headers: SAME_ORIGIN,
  });
  expect(created.ok()).toBe(true);
  const garmentId = new URL(created.url()).pathname.split('/').pop();
  const uploaded = await page.request.post(`/wardrobe/${garmentId}/photo`, {
    multipart: {
      photo: {
        name: 'photo.jpg',
        mimeType: 'image/jpeg',
        buffer: await twoTone(),
      },
    },
    headers: SAME_ORIGIN,
  });
  expect(uploaded.ok()).toBe(true);

  await page.goto(`/wardrobe/${garmentId}`);
  const hero = page.locator('#garment-photo img');
  const first = (await hero.getAttribute('src'))!;

  const sheet = await openPhotoSheet(page);
  const right = sheet.getByRole('button', { name: 'Rotate right' });
  const left = sheet.getByRole('button', { name: 'Rotate left' });
  // Both fit beside each other on the phone's screen.
  for (const button of [left, right]) {
    await expect(button).toBeVisible();
    const box = (await button.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }

  const rotations: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith(`/wardrobe/${garmentId}/photo/rotate`)) {
      rotations.push(request.postData() ?? '');
    }
  });

  // First tap: a quarter turn, and the sheet is open again for the next.
  await right.tap();
  await expect(hero).not.toHaveAttribute('src', first);
  await expect(sheet).toBeVisible();
  // The marker is gone from the address: a reload does not reopen it.
  expect(new URL(page.url()).searchParams.has('photoRotated')).toBe(false);
  const second = (await hero.getAttribute('src'))!;
  const quarter = await heroOriginal(page, second);
  expect(quarter.size).toEqual([720, 1080]);
  expect(quarter.redAt(360, 100)).toBe(true);

  // Second tap, straight from the reopened sheet: 180° in all.
  await right.tap();
  await expect(hero).not.toHaveAttribute('src', second);
  await expect(sheet).toBeVisible();
  const half = await heroOriginal(page, (await hero.getAttribute('src'))!);
  expect(half.size).toEqual([1080, 720]);
  // Red was on the left; turned twice it is on the right.
  expect(half.redAt(900, 360)).toBe(true);
  expect(half.redAt(100, 360)).toBe(false);

  expect(rotations).toEqual(['direction=right', 'direction=right']);
});
