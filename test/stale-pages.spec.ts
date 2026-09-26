import { expect, type Page, test } from '@playwright/test';
import { createGarment } from './support/e2e-data';
import { E2E_PASSWORD, signIn, signUpHeaders } from './support/e2e-session';
import {
  ageCachedPage,
  cachedPaths,
  cachePage,
  waitForServiceWorker,
} from './support/service-worker';

/**
 * The tab roots open stale-while-revalidate (views/assets/src-sw.ts): the
 * cached copy at once, with "Updated N ago" when it is old, then the
 * server's copy swapped in (untouched page) or offered (the user is already
 * reading). And the page cache never serves one account's page to another.
 *
 * Needs a server started with PWA_ENABLED=true; Chromium only, like
 * pwa.spec.ts.
 */
test.describe('stale-while-revalidate tab roots', () => {
  test.skip(
    process.env.PWA_ENABLED !== 'true',
    'needs a server started with PWA_ENABLED=true',
  );
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'service workers are only reliable in chromium here',
  );

  const FIVE_MINUTES = 5 * 60_000;

  const cachedStamp = (response: Awaited<ReturnType<Page['goto']>>) =>
    response?.headers()['x-sw-cached-at'];

  test('a second visit opens from the cache and says how old it is', async ({
    page,
    context,
  }) => {
    await signIn(page, 'swr-open');
    await createGarment(page, 'Cached coat', 'coats');
    await waitForServiceWorker(page);
    await cachePage(page, '/wardrobe');

    // Online and unchanged: the cached copy, confirmed by the server, no age.
    const online = await page.goto('/wardrobe');
    expect(cachedStamp(online)).toBeTruthy();
    await expect(page.getByText('Cached coat')).toBeVisible();
    await page.waitForTimeout(1_500); // past the revalidation's grace
    await expect(page.locator('#freshness')).toBeHidden();

    // Offline, five minutes later: the copy, and how old it is.
    await ageCachedPage(page, '/wardrobe', FIVE_MINUTES);
    await context.setOffline(true);
    const offline = await page.goto('/wardrobe');
    expect(cachedStamp(offline)).toBeTruthy();
    await expect(page.getByText('Cached coat')).toBeVisible();
    await expect(page.locator('#freshness')).toHaveText(
      'Updated 5 minutes ago',
    );
    await expect(page.locator('#connectivity-banner')).toBeVisible();

    // Back online the page asks the server again; nothing changed, so it
    // simply stops saying it is old.
    await context.setOffline(false);
    await expect(page.locator('#freshness')).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText('Cached coat')).toBeVisible();
  });

  test('an untouched page is swapped for the server’s newer one', async ({
    page,
  }) => {
    await signIn(page, 'swr-swap');
    await waitForServiceWorker(page);
    await cachePage(page, '/wardrobe');
    // Changed behind the cache's back (another device, the API context).
    await createGarment(page, 'Added elsewhere', 'coats');

    const response = await page.goto('/wardrobe');
    expect(cachedStamp(response)).toBeTruthy(); // the stale copy came first
    await expect(page.getByText('Added elsewhere')).toBeVisible();
    await expect(page.locator('#freshness')).toBeHidden();
    await expect(page.getByText('Newer version of this page')).toHaveCount(0);
  });

  test('a page the user is reading is offered the newer one, never moved', async ({
    page,
    context,
  }) => {
    await signIn(page, 'swr-offer');
    await waitForServiceWorker(page);
    await cachePage(page, '/wardrobe');
    await createGarment(page, 'Added while away', 'coats');
    await ageCachedPage(page, '/wardrobe', FIVE_MINUTES);

    // Opened offline: the old copy, nothing to compare it with yet.
    await context.setOffline(true);
    await page.goto('/wardrobe');
    await expect(page.locator('#freshness')).toHaveText(
      'Updated 5 minutes ago',
    );
    // The user is on it.
    await page.keyboard.press('Shift');

    await context.setOffline(false);
    const offer = page.getByRole('status').filter({
      hasText: 'Newer version of this page',
    });
    await expect(offer).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Added while away')).toHaveCount(0);

    await offer.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.getByText('Added while away')).toBeVisible();
    await expect(offer).toHaveCount(0);
    await expect(page.locator('#freshness')).toBeHidden();
  });

  test('after signing out, the next account never sees the previous one’s page', async ({
    page,
    playwright,
  }) => {
    await signIn(page, 'swr-first');
    await createGarment(page, 'First account coat', 'coats');
    await waitForServiceWorker(page);
    await cachePage(page, '/wardrobe');

    // The second account, registered outside this browser.
    const api = await playwright.request.newContext({
      baseURL: 'http://localhost:3000',
    });
    const second = `swr-second-${Date.now()}@example.com`;
    const registered = await api.post('/auth/register', {
      form: {
        email: second,
        password: E2E_PASSWORD,
        confirmPassword: E2E_PASSWORD,
      },
      headers: signUpHeaders(),
    });
    expect(registered.ok()).toBe(true);
    await api.dispose();

    await page
      .getByRole('button', { name: 'Logout' })
      .filter({ visible: true })
      .click();
    await expect(page).toHaveURL(/\/auth\/login$/);
    await page.locator('#email').fill(second);
    await page.locator('#password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Login' }).click();
    await expect(page).toHaveURL(/\/auth\/profile$/);

    const response = await page.goto('/wardrobe');
    expect(cachedStamp(response)).toBeUndefined();
    expect(await response?.text()).not.toContain('First account coat');
    await expect(page.getByText('First account coat')).toHaveCount(0);
  });

  test('a page for another account empties the cache before a tab root is opened', async ({
    page,
  }) => {
    await signIn(page, 'swr-unseen-a');
    await createGarment(page, 'Unseen coat', 'coats');
    await waitForServiceWorker(page);
    await cachePage(page, '/wardrobe');

    // A sign-in the worker never sees (the API context shares the cookies
    // but not the worker): the first page for the new account empties the
    // cache.
    await signIn(page, 'swr-unseen-b');
    await page.goto('/outfits');
    await expect.poll(() => cachedPaths(page)).not.toContain('/wardrobe');

    const response = await page.goto('/wardrobe');
    expect(cachedStamp(response)).toBeUndefined();
    await expect(page.getByText('Unseen coat')).toHaveCount(0);
  });

  test('a tab root cached for another account is reloaded as soon as the server says so', async ({
    page,
  }) => {
    await signIn(page, 'swr-backstop-a');
    await createGarment(page, 'Backstop coat', 'coats');
    await waitForServiceWorker(page);
    await cachePage(page, '/wardrobe');

    // Unseen sign-in, then straight to the tab root: the only way a copy
    // can meet the wrong session. Its revalidation says so, the worker drops
    // every cached page and the page reloads from the server.
    await signIn(page, 'swr-backstop-b');
    await page.goto('/wardrobe');
    await expect(page.getByText('Backstop coat')).toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(page.locator('#wardrobe-main')).toBeVisible();
  });
});
