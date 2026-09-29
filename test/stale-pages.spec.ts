import { expect, type Page, test } from '@playwright/test';
import { createGarment } from './support/e2e-data';
import {
  registerElsewhere,
  signIn,
  switchAccount,
} from './support/e2e-session';
import {
  ageCachedPage,
  cachedPaths,
  cachePage,
  networkSwitch,
  PAGES_CACHE,
  waitForServiceWorker,
  workerLogs,
} from './support/service-worker';
import {
  WEBKIT_CANNOT_NAVIGATE_OFFLINE,
  WEBKIT_CANNOT_WATCH_WORKER,
} from './support/webkit-limits';

/**
 * ageCachedPage, for a copy this build's worker stored: its activation moves
 * back with the copy. A copy older than the activation is an older build's,
 * which the worker deletes instead of serving (StaleTabRoot).
 */
async function ageCopy(page: Page, path: string, ageMs: number) {
  await ageCachedPage(page, path, ageMs);
  await page.evaluate(
    async ({ cacheName, ageMs }) => {
      const cache = await caches.open(cacheName);
      await cache.put(
        'https://page-cache.invalid/activated-at',
        new Response(String(Date.now() - ageMs - 60_000)),
      );
    },
    { cacheName: PAGES_CACHE, ageMs },
  );
}

/** Every key in the page cache, query and fragment suffix included. */
function cachedKeys(page: Page): Promise<string[]> {
  return page.evaluate(async (cacheName) => {
    const cache = await caches.open(cacheName);
    return (await cache.keys()).map((request) => {
      const url = new URL(request.url);
      return `${url.pathname}${url.search}`;
    });
  }, PAGES_CACHE);
}

/** Searches the wardrobe: an htmx fragment into #wardrobe-main. */
async function searchWardrobe(page: Page, keyword: string): Promise<void> {
  // Search is its icon until tapped (the scope row, R3).
  await page.locator('#search-form label').click();
  const field = page.getByRole('textbox', { name: 'Search' });
  await field.fill(keyword);
  await field.press('Enter');
  await expect(page).toHaveURL(new RegExp(`keyword=${keyword}`));
}

/**
 * The tab roots open stale-while-revalidate (views/assets/src-sw.ts): the
 * cached copy at once, with "Updated N ago" when it is old, then the
 * server's copy swapped in (untouched page) or offered (the user is already
 * reading). And the page cache never serves one account's page to another.
 *
 * Needs a server started with PWA_ENABLED=true. Chromium runs every test,
 * the Safari projects all but the offline ones, like pwa.spec.ts.
 */
test.describe('stale-while-revalidate tab roots', () => {
  test.skip(
    process.env.PWA_ENABLED !== 'true',
    'needs a server started with PWA_ENABLED=true',
  );
  test.skip(
    ({ browserName }) => browserName === 'firefox',
    'service workers are untested in Firefox here',
  );

  const FIVE_MINUTES = 5 * 60_000;

  const cachedStamp = (response: Awaited<ReturnType<Page['goto']>>) =>
    response?.headers()['x-sw-cached-at'];

  test('a second visit opens from the cache and says how old it is', async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(browserName === 'webkit', WEBKIT_CANNOT_NAVIGATE_OFFLINE);
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

    // Offline, five minutes later: the copy, and how old it is. networkSwitch,
    // not context.setOffline: the page's own REVALIDATE_PAGE ask (#240) is
    // the worker's own fetch, which setOffline alone does not cut (test/CLAUDE.md).
    await ageCopy(page, '/wardrobe', FIVE_MINUTES);
    const network = await networkSwitch(context);
    await network('offline');
    const offline = await page.goto('/wardrobe');
    expect(cachedStamp(offline)).toBeTruthy();
    await expect(page.getByText('Cached coat')).toBeVisible();
    await expect(page.locator('#freshness')).toHaveText(
      'Updated 5 minutes ago',
    );
    await expect(page.locator('#connectivity-banner')).toBeVisible();

    // Back online the page asks the server again; nothing changed, so it
    // simply stops saying it is old.
    await network('online');
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
    browserName,
  }) => {
    test.skip(browserName === 'webkit', WEBKIT_CANNOT_NAVIGATE_OFFLINE);
    await signIn(page, 'swr-offer');
    await waitForServiceWorker(page);
    await cachePage(page, '/wardrobe');
    await createGarment(page, 'Added while away', 'coats');
    await ageCopy(page, '/wardrobe', FIVE_MINUTES);

    // Opened offline: the old copy, nothing to compare it with yet.
    // networkSwitch, not context.setOffline: the page's own REVALIDATE_PAGE
    // ask (#240) is the worker's own fetch, which setOffline alone does not
    // cut (test/CLAUDE.md).
    const network = await networkSwitch(context);
    await network('offline');
    await page.goto('/wardrobe');
    await expect(page.locator('#freshness')).toHaveText(
      'Updated 5 minutes ago',
    );
    // The user is on it.
    await page.keyboard.press('Shift');

    await network('online');
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

    await switchAccount(
      page,
      await registerElsewhere(playwright, 'swr-second'),
    );

    const response = await page.goto('/wardrobe');
    expect(cachedStamp(response)).toBeUndefined();
    expect(await response?.text()).not.toContain('First account coat');
    await expect(page.getByText('First account coat')).toHaveCount(0);
  });

  test('a sign-out the server took but whose answer never arrived still drops the cached pages', async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(browserName === 'webkit', WEBKIT_CANNOT_WATCH_WORKER);
    await signIn(page, 'swr-lost-answer');
    await waitForServiceWorker(page);
    await cachePage(page, '/wardrobe');

    // The server signs out; the connection drops before its answer arrives,
    // so the worker's fetch rejects.
    let signedOut = false;
    await context.route('**/auth/logout', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fallback();
        return;
      }
      const response = await route.fetch({ maxRedirects: 0 });
      signedOut = response.status() === 303;
      await route.abort('connectionreset');
    });
    const noAnswer = workerLogs(context, '/auth/logout got no answer');
    await page.locator('#avatar').click();
    await page
      .locator('#sign-out')
      .getByRole('button', { name: 'Logout' })
      .click();
    await noAnswer;
    expect(signedOut).toBe(true);

    // The tapped page is left on whatever the catch handler answered; a
    // second tab reads the cache from a document that is no page, so no
    // page of its own (signed out now: the cookie went with the answer
    // route.fetch received) can drop the cache in the worker's place.
    const probe = await context.newPage();
    await probe.goto('/manifest.json');
    await expect.poll(() => cachedPaths(probe)).not.toContain('/wardrobe');
  });

  test('a slow page for the previous account never reaches the next one (#121)', async ({
    page,
    context,
    playwright,
    browserName,
  }) => {
    test.skip(browserName === 'webkit', WEBKIT_CANNOT_WATCH_WORKER);
    await signIn(page, 'swr-race-a');
    await createGarment(page, 'Race coat', 'coats');
    await waitForServiceWorker(page);
    const second = await registerElsewhere(playwright, 'swr-race-b');
    const network = await networkSwitch(context);

    // The server renders the first account's /wardrobe at once; its answer
    // reaches the worker only after the other tab has switched accounts and
    // the device has gone offline (so no later page of the new account, not
    // even the offline page the worker re-warms after a drop, can put the
    // cache right again). Registered after networkSwitch, so it goes first.
    let answered!: () => void;
    const rendered = new Promise<void>((resolve) => (answered = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    await context.route(
      (url) => url.pathname === '/wardrobe',
      async (route) => {
        if (route.request().headers()['x-held'] !== 'true') {
          await route.fallback();
          return;
        }
        const response = await route.fetch();
        answered();
        await released;
        await route.fulfill({ response });
      },
    );
    // A boosted tap in the first tab: a whole page, cached as /wardrobe.
    await page.evaluate(() => {
      void fetch('/wardrobe', {
        headers: {
          'HX-Request': 'true',
          'HX-Boosted': 'true',
          'X-Held': 'true',
        },
      }).catch(() => undefined);
    });
    await rendered;

    const other = await context.newPage();
    await other.goto('/auth/profile');
    await switchAccount(other, second);
    await expect.poll(() => cachedPaths(other)).toContain('/auth/profile');
    await network('offline');

    const refused = workerLogs(context, '/wardrobe answered from generation');
    release();
    await refused;

    // The new account opens the tab root: never the old account's copy.
    await other.goto('/wardrobe');
    await expect(other.getByText('Offline.')).toBeVisible();
    await expect(other.getByText('Race coat')).toHaveCount(0);
    expect(await cachedPaths(other)).not.toContain('/wardrobe');
  });

  test('two tabs opening the same tab root each learn how old their copy is', async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(browserName === 'webkit', WEBKIT_CANNOT_NAVIGATE_OFFLINE);
    await signIn(page, 'swr-two-tabs');
    await waitForServiceWorker(page);
    await cachePage(page, '/wardrobe');
    await ageCopy(page, '/wardrobe', FIVE_MINUTES);

    // Each tab reads its own document's Server-Timing and asks for its own
    // REVALIDATE_PAGE (#240): nothing shared between them to race, unlike
    // the worker's own former in-memory record of what it served, keyed by
    // the navigation's resultingClientId, which two opens racing each other
    // could once have crossed.
    const second = await context.newPage();
    const network = await networkSwitch(context);
    await network('offline');
    await Promise.all([page.goto('/wardrobe'), second.goto('/wardrobe')]);

    for (const tab of [page, second]) {
      await expect(tab.locator('#freshness')).toHaveText(
        'Updated 5 minutes ago',
      );
    }
  });

  test('a filtered wardrobe shown from the cache is revalidated as its fragment', async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(browserName === 'webkit', WEBKIT_CANNOT_NAVIGATE_OFFLINE);
    await signIn(page, 'swr-fragment');
    await createGarment(page, 'Rain coat', 'coats');
    await waitForServiceWorker(page);
    await cachePage(page, '/wardrobe');
    // Searching swaps #wardrobe-main: a fragment, cached under its own key.
    await searchWardrobe(page, 'coat');
    await expect
      .poll(() => cachedKeys(page))
      .toContain('/wardrobe?keyword=coat|hx');
    await createGarment(page, 'Wool coat', 'coats');
    await ageCopy(page, '/wardrobe?keyword=coat|hx', FIVE_MINUTES);

    const network = await networkSwitch(context);
    await network('offline');
    await page.goto('/wardrobe');
    await expect(page.locator('#connectivity-banner')).toBeVisible();
    await searchWardrobe(page, 'coat');
    await expect(page.locator('#freshness')).toHaveText(
      'Updated 5 minutes ago',
    );
    await expect(page.getByText('Rain coat')).toBeVisible();
    await expect(page.getByText('Wool coat')).toHaveCount(0);

    // Back online the fragment is asked for again and swapped into place.
    await network('online');
    await expect(page.getByText('Wool coat')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#freshness')).toBeHidden();
    await expect(page.locator('#wardrobe-main')).toHaveCount(1);
    await expect(page).toHaveURL(/keyword=coat/);
  });

  test('a tab root cached before this worker activated is never served, even offline', async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(browserName === 'webkit', WEBKIT_CANNOT_NAVIGATE_OFFLINE);
    await signIn(page, 'swr-old-build');
    await createGarment(page, 'Old build coat', 'coats');
    await waitForServiceWorker(page);
    await cachePage(page, '/wardrobe');
    // Older than the activation: as an older build's worker stored it.
    await ageCachedPage(page, '/wardrobe', FIVE_MINUTES);

    await context.setOffline(true);
    await page.goto('/wardrobe');
    await expect(page.getByText('Offline.')).toBeVisible();
    await expect(page.getByText('Old build coat')).toHaveCount(0);
    expect(await cachedPaths(page)).not.toContain('/wardrobe');
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
