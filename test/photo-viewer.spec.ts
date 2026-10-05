import { expect, type Page, test } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { planItem } from '../src/db/schema';
import { changeCandidates } from '../src/web/plans/candidates';
import { proposeLook } from '../src/web/plans/looks';
import { addPhotographedGarment } from './support/e2e-data';
import { SAME_ORIGIN, signIn } from './support/e2e-session';
import { pageErrors } from './support/page-errors';
import { blockingScrollListeners } from './support/scroll-listeners';
import { userIdOf, withServerDb } from './support/server-db';
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

const WISHLIST = { to: 'wishlist', wishlist: '1', props: '1', product: '1' };

/** A plan with one item to buy (two candidates with photos) and a look of photographed pieces. */
async function seed(page: Page) {
  const email = await signIn(page, 'photo-viewer');
  const res = await page.request.post('/wardrobe/plans', {
    form: { name: 'Autumn' },
    headers: SAME_ORIGIN,
  });
  const plan = new URL(res.url()).pathname;
  const planId = Number(plan.split('/').pop());
  await page.request.post(`${plan}/items`, {
    form: { name: 'Hat', category: 'hats', quantity: '1', priority: 'medium' },
    headers: SAME_ORIGIN,
  });
  const beanie = await addPhotographedGarment(page, 'Beanie', 'hats', WISHLIST);
  const bucket = await addPhotographedGarment(
    page,
    'Bucket hat',
    'hats',
    WISHLIST,
  );
  const tee = await addPhotographedGarment(page, 'Grey tee', 'tops');
  const chinos = await addPhotographedGarment(page, 'Chinos', 'bottoms');
  const boots = await addPhotographedGarment(page, 'Boots', 'footwear');
  await withServerDb(async (db) => {
    const ownerId = await userIdOf(db, email);
    const [{ id: itemId }] = await db
      .select({ id: planItem.id })
      .from(planItem)
      .where(eq(planItem.planId, planId));
    await changeCandidates(db, ownerId, {
      add: { itemIds: [itemId], garmentIds: [beanie, bucket] },
    });
    await proposeLook(
      db,
      ownerId,
      planId,
      { name: 'Easy Friday', occasion: 'work', note: 'Nothing to buy' },
      [tee, chinos, boots],
    );
  });
  return { planId, tee };
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

  test('the plan page: the card and the sheet open the item’s candidates, a look’s piece its pieces', async ({
    page,
  }) => {
    const { planId } = await seed(page);
    await page.goto(`/wardrobe/plans/${planId}`);
    await page
      .getByRole('button', { name: /^Enlarge photo of /u })
      .first()
      .click();
    await expect(position(page)).toHaveText('1 of 2');
    await page.keyboard.press('Escape');

    // The sheet's photo, with the sheet still open beneath the viewer.
    await page
      .getByRole('button', { name: /Any hats|Hat/u })
      .first()
      .click();
    await page.locator('dialog[open] [data-photo-open]').click();
    await expect(position(page)).toHaveText('1 of 2');
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog[open]')).toHaveCount(1);
    await page.keyboard.press('Escape');

    await page.goto(`/wardrobe/plans/${planId}?view=outfits`);
    await page.locator('#plan-looks [data-photo-open]').first().focus();
    await page.keyboard.press('Enter');
    await expect(position(page)).toHaveText('1 of 3');
    await page.keyboard.press('Escape');
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

  test('the Looks strip tile opens its pieces', async ({ page }) => {
    const { planId } = await seed(page);
    await page.goto(`/wardrobe/plans/${planId}?view=outfits`);
    const piece = page
      .locator('#plan-looks [data-selected] [data-photo-open]')
      .first();
    await piece.scrollIntoViewIfNeeded();
    await piece.tap();
    await expect(position(page)).toHaveText(/1 of 3|2 of 3|3 of 3/u);
    await page.screenshot({ path: 'test-results/313-viewer-looks-390.png' });
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
