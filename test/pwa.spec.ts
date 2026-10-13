import { test, expect } from '@playwright/test';
import { signIn } from './support/e2e-session';
import { waitForServiceWorker, withoutWarming } from './support/service-worker';
import { WEBKIT_CANNOT_NAVIGATE_OFFLINE } from './support/webkit-limits';

/**
 * What only a browser can show about the installed app: online, the worker
 * answers a navigation from its preload; offline, a visited page comes from
 * its page cache with the connectivity banner and an unvisited one is the
 * offline page. The worker's caching rules themselves (src/web/shell/) are
 * served by the integration tier's shell specs.
 *
 * Needs a server started with PWA_ENABLED=true (and VAPID keys). The Safari
 * projects (nightly) cannot navigate offline and skip it.
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
  // What the offline specs find cached is their own visits' alone.
  test.beforeEach(async ({ page, context }) => {
    await withoutWarming(context);
    await signIn(page, 'pwa-test');
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

    await expect(page.locator('#connectivity-banner')).toBeHidden();
    await context.setOffline(true);
    // Visited above, so the page cache has it: served from there while the
    // preload fails behind it, and the app says it is offline.
    await page.goto('/outfits');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Outfits' }),
    ).toBeVisible();
    await expect(page.locator('.dock')).toBeVisible();
    await expect(page.locator('#connectivity-banner')).toBeVisible();
    // Never visited: the offline page.
    await page.goto('/calendar');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Offline.' }),
    ).toBeVisible();
    await context.setOffline(false);
  });
});
