import { test, expect, Page } from '@playwright/test';
import { SAME_ORIGIN, signIn } from './support/e2e-session';

/**
 * What only a browser can show about the installed app: the service worker
 * serves the shell from cache, the app still renders offline with the
 * connectivity banner, and a garment page no longer pulls the background
 * removal runtime and model just for being opened.
 *
 * Needs a server started with PWA_ENABLED=true (and VAPID keys); Chromium
 * only, the one Playwright engine with usable service worker support.
 */
test.describe('installed app delivery', () => {
  test.skip(
    process.env.PWA_ENABLED !== 'true',
    'needs a server started with PWA_ENABLED=true',
  );
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'service workers are only reliable in chromium here',
  );

  // Login is always required: without a session every page below would be
  // the login page (which also loads bundle.css, so the first test passed
  // on the wrong page).
  test.beforeEach(async ({ page }) => {
    await signIn(page, 'pwa-test');
  });

  async function waitForServiceWorker(page: Page) {
    await page.goto('/wardrobe');
    await page.evaluate(() => navigator.serviceWorker.ready);
    // A freshly registered worker precaches in the background; wait until it
    // controls the page so the next navigation goes through it.
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  }

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
  }) => {
    await waitForServiceWorker(page);
    // The wardrobe page itself is NetworkFirst; visit it through the worker
    // once so a copy is in pages-v1.
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

  test('signing out drops the cached pages', async ({ page }) => {
    await waitForServiceWorker(page);
    await page.goto('/wardrobe');
    const cachedPages = () =>
      page.evaluate(async () => {
        const cache = await caches.open('pages-v1');
        return (await cache.keys()).map(
          (request) => new URL(request.url).pathname,
        );
      });
    expect(await cachedPages()).toContain('/wardrobe');

    await page.goto('/auth/logout');
    await expect(page).toHaveURL(/\/auth\/login$/);
    await expect
      .poll(async () => (await cachedPages()).includes('/wardrobe'))
      .toBe(false);
  });

  test('opening a garment does not download the background removal model', async ({
    page,
  }) => {
    const createResponse = await page.request.post('/wardrobe', {
      form: { name: 'Lazy model garment', category: 'shirt' },
      headers: SAME_ORIGIN,
    });
    const garmentId = new URL(createResponse.url()).pathname.split('/').pop();

    const heavy: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (
        url.pathname.startsWith('/bg-removal-models/') ||
        url.pathname.startsWith('/modules/background-removal/') ||
        url.pathname.startsWith('/modules/onnxruntime-web/')
      ) {
        heavy.push(url.pathname);
      }
    });

    await page.goto(`/wardrobe/${garmentId}`);
    await expect(page.locator('#photoInput')).toBeVisible();
    await page.waitForTimeout(1500);
    expect(heavy).toEqual([]);

    // Intent starts the download.
    await page.locator('#photoInput').focus();
    await expect
      .poll(() => heavy.length, { timeout: 15_000 })
      .toBeGreaterThan(0);
  });
});
