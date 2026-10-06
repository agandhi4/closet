import { expect, type Page, test } from '@playwright/test';
import { addPhotographedGarment } from './support/e2e-data';
import { signIn } from './support/e2e-session';
import { pageErrors } from './support/page-errors';
import { blockingScrollListeners } from './support/scroll-listeners';
import { networkSwitch, waitForServiceWorker } from './support/service-worker';

/**
 * The shared photo viewer (#313, src/web/files/photo-viewer.tsx,
 * public/js/photo-viewer.js): open from a photo, step through its set,
 * zoom, close, focus back. Its markup rules are
 * test/integration/photo-viewer.spec.ts's. Chromium only: the swipes are
 * real touch gestures through the DevTools protocol.
 */
test.skip(
  ({ browserName }) => browserName !== 'chromium',
  'CDP touch gestures',
);

/** A photographed closet garment of a new user's. */
async function seed(page: Page) {
  await signIn(page, 'photo-viewer');
  return { tee: await addPhotographedGarment(page, 'Grey tee', 'tops') };
}

const viewer = (page: Page) => page.locator('#photo-viewer');
const position = (page: Page) => viewer(page).locator('[data-photo-position]');

/** The garment page once its cutout has arrived: the viewer's set is then the cutout and the photo. */
async function openGarment(page: Page, id: number) {
  await page.goto(`/wardrobe/${id}`);
  await expect(page.locator('#garment-photo img')).toHaveAttribute(
    'src',
    /v=2/u,
  );
}

/** A finger from the middle, moved by (dx, dy) in small steps: the real touch pipeline, so scroll-snap and the touch handlers see a swipe. */
async function swipe(page: Page, dx: number, dy = 0) {
  const cdp = await page.context().newCDPSession(page);
  const from = { x: 195, y: 420 };
  const touch = (
    type: 'touchStart' | 'touchMove' | 'touchEnd',
    x: number,
    y: number,
  ) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
    });
  await touch('touchStart', from.x, from.y);
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await touch(
      'touchMove',
      from.x + (dx * i) / steps,
      from.y + (dy * i) / steps,
    );
    await page.waitForTimeout(16);
  }
  await touch('touchEnd', 0, 0);
  await cdp.detach();
}

test.describe('on a desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('the garment page: open, step, zoom, close with Esc and the button, focus back', async ({
    page,
  }) => {
    const errors = pageErrors(page);
    const { tee } = await seed(page);
    await openGarment(page, tee);
    const photo = page.getByRole('button', {
      name: 'Enlarge photo of Grey tee',
    });
    await photo.click();
    await expect(viewer(page)).toBeVisible();
    await expect(position(page)).toHaveText('1 of 2');
    // Focus moved into the viewer.
    await expect(
      viewer(page).getByRole('button', { name: 'Close' }),
    ).toBeFocused();
    await expect(
      viewer(page).locator('.photo-viewer-slide img').first(),
    ).toHaveJSProperty('complete', true);

    await page.screenshot({ path: 'test-results/313-viewer-1440.png' });

    await page.keyboard.press('ArrowRight');
    await expect(position(page)).toHaveText('2 of 2');
    await expect(
      viewer(page).getByRole('button', { name: 'Next photo' }),
    ).toBeDisabled();
    await viewer(page).getByRole('button', { name: 'Previous photo' }).click();
    await expect(position(page)).toHaveText('1 of 2');

    // Click zooms to twice the fitted size, and again zooms out.
    const image = viewer(page).locator('.photo-viewer-slide img').first();
    const fitted = (await image.boundingBox())!;
    await image.click();
    await expect(
      viewer(page).getByRole('button', { name: 'Zoom' }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect((await image.boundingBox())!.width).toBeGreaterThan(
      fitted.width * 1.5,
    );
    await viewer(page).getByRole('button', { name: 'Zoom' }).click();
    await expect(
      viewer(page).getByRole('button', { name: 'Zoom' }),
    ).toHaveAttribute('aria-pressed', 'false');

    await page.keyboard.press('Escape');
    await expect(viewer(page)).toBeHidden();
    await expect(photo).toBeFocused();

    await photo.click();
    await viewer(page).getByRole('button', { name: 'Close' }).click();
    await expect(viewer(page)).toBeHidden();
    await expect(photo).toBeFocused();
    expect(errors).toEqual([]);
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('swipe between photos, double-tap to zoom, swipe down to close', async ({
    page,
  }) => {
    const errors = pageErrors(page);
    const { tee } = await seed(page);
    await openGarment(page, tee);
    // The pinch's non-passive touchmove exists only while the viewer is
    // open; closed, nothing on the page holds up scrolling.
    expect(await blockingScrollListeners(page)).toEqual([]);
    await page.getByRole('button', { name: 'Enlarge photo of Grey tee' }).tap();
    await expect(position(page)).toHaveText('1 of 2');
    await page.screenshot({ path: 'test-results/313-viewer-390.png' });

    await swipe(page, -300);
    await expect(position(page)).toHaveText('2 of 2');
    await swipe(page, 300);
    await expect(position(page)).toHaveText('1 of 2');

    const image = viewer(page).locator('.photo-viewer-slide img').first();
    const fitted = (await image.boundingBox())!;
    const box = fitted;
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.touchscreen.tap(at.x, at.y);
    await page.touchscreen.tap(at.x, at.y);
    await expect(
      viewer(page).getByRole('button', { name: 'Zoom' }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect((await image.boundingBox())!.width).toBeGreaterThan(
      fitted.width * 1.5,
    );
    await viewer(page).getByRole('button', { name: 'Zoom' }).tap();

    await swipe(page, 0, 300);
    await expect(viewer(page)).toBeHidden();
    await expect(
      page.getByRole('button', { name: 'Enlarge photo of Grey tee' }),
    ).toBeFocused();
    expect(errors).toEqual([]);
  });

  test('a two-finger pinch zooms the photo, not the page, and the controls stay', async ({
    page,
  }) => {
    const { tee } = await seed(page);
    await openGarment(page, tee);
    await page.getByRole('button', { name: 'Enlarge photo of Grey tee' }).tap();
    const image = viewer(page).locator('.photo-viewer-slide img').first();
    await expect(image).toHaveJSProperty('complete', true);
    const fitted = (await image.boundingBox())!;
    const caption = viewer(page).locator('[data-photo-caption]');
    const captionBefore = (await caption.boundingBox())!;

    const cdp = await page.context().newCDPSession(page);
    const points = (gap: number) => [
      { x: 195 - gap, y: 420, id: 1 },
      { x: 195 + gap, y: 420, id: 2 },
    ];
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: points(20),
    });
    for (let gap = 20; gap <= 120; gap += 10) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: points(gap),
      });
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
    await cdp.detach();

    await expect
      .poll(async () => (await image.boundingBox())!.width)
      .toBeGreaterThan(fitted.width * 2);
    await expect(
      viewer(page).getByRole('button', { name: 'Zoom' }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => window.visualViewport!.scale)).toBe(1);
    expect((await caption.boundingBox())!.height).toBe(captionBefore.height);

    await viewer(page).getByRole('button', { name: 'Zoom' }).tap();
    await expect
      .poll(async () => (await image.boundingBox())!.width)
      .toBeLessThan(fitted.width * 1.05);
  });
});

test.describe('offline', () => {
  test.skip(
    process.env.PWA_ENABLED !== 'true',
    'needs a server started with PWA_ENABLED=true',
  );
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('a photo already cached opens in the viewer with no network', async ({
    page,
    context,
  }) => {
    const errors = pageErrors(page);
    const network = await networkSwitch(context);
    const { tee } = await seed(page);
    await waitForServiceWorker(page);
    await openGarment(page, tee);
    await expect(page.locator('#garment-photo img')).toHaveJSProperty(
      'complete',
      true,
    );
    await network('offline');
    await page.getByRole('button', { name: 'Enlarge photo of Grey tee' }).tap();
    await expect(position(page)).toHaveText('1 of 2');
    const slide = viewer(page).locator('.photo-viewer-slide img').first();
    await expect
      .poll(() => slide.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);
    await viewer(page).getByRole('button', { name: 'Close' }).tap();
    await expect(viewer(page)).toBeHidden();
    await network('online');
    expect(errors).toEqual([]);
  });
});
