import {
  type BrowserContext,
  expect,
  type Page,
  type PlaywrightWorkerArgs,
  test,
} from '@playwright/test';
import { createGarment } from './support/e2e-data';
import {
  APP_ORIGIN,
  E2E_PASSWORD,
  signIn,
  signUpHeaders,
} from './support/e2e-session';
import {
  ageCachedPage,
  cachedPaths,
  cachePage,
  PAGES_CACHE,
  waitForServiceWorker,
} from './support/service-worker';

declare global {
  interface Window {
    /** Lets the page's held worker messages go (the two-tab test). */
    releaseWorkerMessages?: () => void;
  }
}

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

/** Registers an account outside this browser; returns its email. */
async function registerElsewhere(
  playwright: PlaywrightWorkerArgs['playwright'],
  prefix: string,
): Promise<string> {
  const api = await playwright.request.newContext({ baseURL: APP_ORIGIN });
  const email = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const registered = await api.post('/auth/register', {
    form: {
      email,
      password: E2E_PASSWORD,
      confirmPassword: E2E_PASSWORD,
    },
    headers: signUpHeaders(),
  });
  expect(registered.ok()).toBe(true);
  await api.dispose();
  return email;
}

/** Signs out through Profile and in again as `email`, in the app. */
async function switchAccount(page: Page, email: string): Promise<void> {
  // Signing out is Profile's, reached through the avatar (#82).
  await page.locator('#avatar').click();
  await page
    .locator('#sign-out')
    .getByRole('button', { name: 'Logout' })
    .click();
  await expect(page).toHaveURL(/\/auth\/login$/);
  // The browser posts from the address every spec shares, and login allows
  // 5 a minute per address: the post names a client of its own, as signIn's
  // registration does.
  await page.context().route('**/auth/login', (route) =>
    route.fallback({
      headers: { ...route.request().headers(), ...signUpHeaders() },
    }),
  );
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page).toHaveURL(/\/auth\/profile$/);
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
 * Takes the device off the network and puts it back. Chromium's setOffline
 * cuts the page's requests and the navigation preload but not a request the
 * worker makes itself (NetworkFirst for an htmx request, REVALIDATE_PAGE),
 * which the route fails meanwhile.
 */
async function networkSwitch(context: BrowserContext) {
  let offline = false;
  await context.route('**/*', async (route) => {
    if (offline) await route.abort('internetdisconnected');
    else await route.fallback();
  });
  return async (state: 'offline' | 'online') => {
    offline = state === 'offline';
    await context.setOffline(offline);
  };
}

/** Resolves once the worker logs a line containing `text`. */
function workerLogs(context: BrowserContext, text: string) {
  return context.waitForEvent('console', {
    predicate: (message) => message.text().includes(text),
    timeout: 15_000,
  });
}

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
    await ageCopy(page, '/wardrobe', FIVE_MINUTES);
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
    await ageCopy(page, '/wardrobe', FIVE_MINUTES);

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

    await switchAccount(
      page,
      await registerElsewhere(playwright, 'swr-second'),
    );

    const response = await page.goto('/wardrobe');
    expect(cachedStamp(response)).toBeUndefined();
    expect(await response?.text()).not.toContain('First account coat');
    await expect(page.getByText('First account coat')).toHaveCount(0);
  });

  test('a slow page for the previous account never reaches the next one (#121)', async ({
    page,
    context,
    playwright,
  }) => {
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
  }) => {
    await signIn(page, 'swr-two-tabs');
    await waitForServiceWorker(page);
    await cachePage(page, '/wardrobe');
    await ageCopy(page, '/wardrobe', FIVE_MINUTES);

    // Each document's question to the worker waits until both documents
    // have been served: two opens racing each other.
    await context.addInitScript(() => {
      const prototype = ServiceWorker.prototype;
      const post = Reflect.get(prototype, 'postMessage') as (
        ...args: unknown[]
      ) => void;
      const open = new Promise<void>((resolve) => {
        window.releaseWorkerMessages = resolve;
      });
      Reflect.set(
        prototype,
        'postMessage',
        function (this: ServiceWorker, ...args: unknown[]) {
          void open.then(() => Reflect.apply(post, this, args));
        },
      );
    });
    const second = await context.newPage();
    await context.setOffline(true);
    await Promise.all([page.goto('/wardrobe'), second.goto('/wardrobe')]);
    for (const tab of [page, second]) {
      await tab.evaluate(() => window.releaseWorkerMessages?.());
    }

    for (const tab of [page, second]) {
      await expect(tab.locator('#freshness')).toHaveText(
        'Updated 5 minutes ago',
      );
    }
  });

  test('a filtered wardrobe shown from the cache is revalidated as its fragment', async ({
    page,
    context,
  }) => {
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
  }) => {
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
