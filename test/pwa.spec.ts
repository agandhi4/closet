import { test, expect } from '@playwright/test';
import sharp from 'sharp';
import { SAME_ORIGIN, signIn } from './support/e2e-session';
import { cachedPaths, waitForServiceWorker } from './support/service-worker';
import { openPhotoSheet } from './support/garment-page';
import { WEBKIT_CANNOT_NAVIGATE_OFFLINE } from './support/webkit-limits';

/**
 * What only a browser can show about the installed app: the service worker
 * serves the shell from cache, the app still renders offline with the
 * connectivity banner, and no page ever fetches a background-removal model
 * or WASM (the server removes backgrounds). test/stale-pages.spec.ts covers
 * the tab roots' stale-while-revalidate and the freshness indicator.
 *
 * Needs a server started with PWA_ENABLED=true (and VAPID keys). Chromium
 * runs every test, the Safari projects (nightly) all but the offline ones.
 */
test.describe('installed app delivery', () => {
  test.skip(
    process.env.PWA_ENABLED !== 'true',
    'needs a server started with PWA_ENABLED=true',
  );
  test.skip(
    ({ browserName }) => browserName === 'firefox',
    'service workers are untested in Firefox here',
  );

  // Login is always required: without a session every page below would be
  // the login page (which also loads bundle.css, so the first test passed
  // on the wrong page).
  test.beforeEach(async ({ page }) => {
    await signIn(page, 'pwa-test');
  });

  test('serves the stylesheet from cache on the second load', async ({
    page,
  }) => {
    await waitForServiceWorker(page);
    await page.reload();
    await page.waitForLoadState('load');

    const css = await page.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .filter((e) => e.name.includes('/bundle.css'))
        .map((e) => ({
          name: e.name,
          transferSize: (e as PerformanceResourceTiming).transferSize,
        })),
    );
    expect(css.length).toBeGreaterThan(0);
    for (const entry of css) {
      expect(entry.name).toContain('?v=');
      expect(entry.transferSize).toBe(0);
    }
  });

  test('renders the cached shell with the offline banner when offline', async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(browserName === 'webkit', WEBKIT_CANNOT_NAVIGATE_OFFLINE);
    await waitForServiceWorker(page);
    // Visit the wardrobe through the worker once so a copy is in its page
    // cache.
    await page.goto('/wardrobe');
    await expect(page.locator('#connectivity-banner')).toBeHidden();

    await context.setOffline(true);
    await page.goto('/wardrobe');

    await expect(page.locator('#wardrobe-main')).toBeVisible();
    await expect(page.locator('.dock')).toBeVisible();
    await expect(page.locator('#connectivity-banner')).toBeVisible();

    await context.setOffline(false);
    await expect(page.locator('#connectivity-banner')).toBeHidden({
      timeout: 10_000,
    });
  });

  test('navigations use the preload online and the cache or offline page offline', async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(browserName === 'webkit', WEBKIT_CANNOT_NAVIGATE_OFFLINE);
    await waitForServiceWorker(page);
    // Enabled in the worker's activate event (views/assets/src-sw.ts).
    await expect
      .poll(() =>
        page.evaluate(async () =>
          (await navigator.serviceWorker.ready).navigationPreload.getState(),
        ),
      )
      .toMatchObject({ enabled: true });

    const online = await page.goto('/outfits');
    expect(online?.fromServiceWorker()).toBe(true);
    expect(online?.status()).toBe(200);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Outfits' }),
    ).toBeVisible();

    await context.setOffline(true);
    // Visited above, so the page cache has it: served from there while the
    // preload fails behind it.
    await page.goto('/outfits');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Outfits' }),
    ).toBeVisible();
    // Never visited: the offline page.
    await page.goto('/calendar');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Offline.' }),
    ).toBeVisible();
    await context.setOffline(false);
  });

  test('navigating never fetches the manifest again', async ({ page }) => {
    await waitForServiceWorker(page);
    const fetched: string[] = [];
    page.on('request', (request) => {
      if (
        new URL(request.url()).pathname === '/manifest.json' &&
        request.resourceType() === 'fetch'
      ) {
        fetched.push(request.url());
      }
    });

    for (const [href, url] of [
      ['/outfits', /\/outfits$/],
      ['/calendar', /\/calendar$/],
      ['/wardrobe', /\/wardrobe$/],
    ] as const) {
      await page.locator(`.dock a[href="${href}"]`).click();
      await expect(page).toHaveURL(url);
    }
    await page.waitForTimeout(500);
    // The install dialog (public/js/pwa.js), when a browser offers
    // installing at all, is mounted once outside the body htmx swaps.
    expect(fetched).toEqual([]);
    await expect(page.locator('body pwa-install')).toHaveCount(0);
  });

  test('signing out drops the cached pages', async ({ page }) => {
    await waitForServiceWorker(page);
    await page.goto('/wardrobe');
    expect(await cachedPaths(page)).toContain('/wardrobe');

    // Signing out is Profile's, reached through the avatar (#82).
    await page.locator('#avatar').click();
    await page
      .locator('#sign-out')
      .getByRole('button', { name: 'Logout' })
      .click();
    await expect(page).toHaveURL(/\/auth\/login$/);
    await expect
      .poll(async () => (await cachedPaths(page)).includes('/wardrobe'))
      .toBe(false);
  });

  test('never requests a model or WASM, through a whole photo upload', async ({
    page,
    context,
  }) => {
    const createResponse = await page.request.post('/wardrobe', {
      form: { name: 'No model garment', category: 'shirt' },
      headers: SAME_ORIGIN,
    });
    const garmentId = new URL(createResponse.url()).pathname.split('/').pop();

    // The context sees the service worker's requests too.
    const model: string[] = [];
    context.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (/onnx|imgly|background-removal|bg-removal|\.wasm$/.test(pathname)) {
        model.push(pathname);
      }
    });

    await waitForServiceWorker(page);
    await page.goto(`/wardrobe/${garmentId}`);
    // What used to start the in-browser model's download.
    await openPhotoSheet(page);
    await page.locator('#photoInput').focus();
    await page.locator('#photoInput').setInputFiles({
      name: 'shirt.jpg',
      mimeType: 'image/jpeg',
      buffer: await sharp({
        create: { width: 900, height: 1200, channels: 3, background: '#3a6' },
      })
        .jpeg()
        .toBuffer(),
    });
    await expect(page.locator('#garment-photo img')).toHaveAttribute(
      'src',
      /\?v=2&k=[0-9a-f]{12}&s=[\w-]{16}$/,
      { timeout: 15_000 },
    );
    await page.locator('#editMaskBtn').click();
    await expect(page.locator('#maskEditorDialog')).toBeVisible();

    expect(model).toEqual([]);
  });
});
