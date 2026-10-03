import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import {
  parseWarmList,
  WARM_LIST_PATH,
  WARM_REQUEST_HEADER,
  type WarmList,
} from '../src/web/shell/offline-warm';
import { addPhotographedGarment, createGarment } from './support/e2e-data';
import {
  changePasswordElsewhere,
  registerElsewhere,
  signIn,
  signInAs,
  switchAccount,
} from './support/e2e-session';
import { seedDemoAs } from './support/seed-demo';
import {
  ageCachedPage,
  cachedImages,
  cachedKeys,
  cachedPaths,
  cachePage,
  networkSwitch,
  PAGES_CACHE,
  waitForServiceWorker,
  warmFinished,
  withoutWarming,
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
  // What this spec caches is its own visits' alone (withoutWarming).
  test.beforeEach(async ({ context }) => {
    await withoutWarming(context);
  });

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

/**
 * The offline warm (#286, src/web/shell/offline-warm.md) fills both session
 * caches with a whole wardrobe: they go together at every session boundary,
 * like a visited page, and a warm under way when one passes stores nothing
 * more (the generation check).
 */
test.describe('a warmed wardrobe and the session', () => {
  test.skip(
    process.env.PWA_ENABLED !== 'true',
    'needs a server started with PWA_ENABLED=true',
  );
  test.skip(
    ({ browserName }) => browserName === 'firefox',
    'service workers are untested in Firefox here',
  );

  test('a warmed wardrobe’s pages and photos go when another account signs in', async ({
    page,
    context,
    playwright,
    browserName,
  }) => {
    test.skip(browserName === 'webkit', WEBKIT_CANNOT_WATCH_WORKER);
    await signIn(page, 'swr-warm-a');
    const garmentId = await addPhotographedGarment(page, 'Warmed coat');
    const warmed = warmFinished(context);
    await waitForServiceWorker(page);
    await page.goto('/outfits');
    await warmed;
    const thumbs = (await cachedImages(page)).filter((url) =>
      url.startsWith('/file/thumb/'),
    );
    expect(thumbs).toHaveLength(1);
    expect(await cachedPaths(page)).toContain(`/wardrobe/${garmentId}`);

    await switchAccount(
      page,
      await registerElsewhere(playwright, 'swr-warm-b'),
    );
    await expect
      .poll(() => cachedPaths(page))
      .not.toContain(`/wardrobe/${garmentId}`);
    expect(await cachedImages(page)).not.toContain(thumbs[0]);
  });

  test('a warm under way when the account changes stores nothing more (#286)', async ({
    page,
    context,
    playwright,
    browserName,
  }) => {
    test.skip(browserName === 'webkit', WEBKIT_CANNOT_WATCH_WORKER);
    await signIn(page, 'swr-midwarm-a');
    const garmentId = await addPhotographedGarment(page, 'Mid-warm coat');
    const second = await registerElsewhere(playwright, 'swr-midwarm-b');
    const network = await networkSwitch(context);

    // Every fetch of the warm (but its list) is answered by the server at
    // once and reaches the worker only after the other tab has switched
    // accounts and the device has gone offline. Registered after
    // networkSwitch, so it goes first.
    const held: string[] = [];
    let answered!: () => void;
    const rendered = new Promise<void>((resolve) => (answered = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (
        !route.request().headers()['x-closet-warm'] ||
        url.pathname === '/offline/warm'
      ) {
        await route.fallback();
        return;
      }
      held.push(`${url.pathname}${url.search}`);
      const response = await route.fetch();
      answered();
      await released;
      await route.fulfill({ response });
    });
    // Profile shows no photo, so the garment's thumb is the warm's to fetch.
    // The worker installs on the first load; the warm starts on whichever
    // load it controls.
    await page.goto('/auth/profile');
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.reload();
    await rendered;

    const other = await context.newPage();
    await other.goto('/auth/profile');
    await switchAccount(other, second);
    await expect.poll(() => cachedPaths(other)).toContain('/auth/profile');
    await network('offline');

    const stopped = workerLogs(
      context,
      '[sw] warm stopped, the session changed',
    );
    release();
    await stopped;

    // Pages and thumbs side by side: both kinds were in flight.
    expect(held.some((url) => url.startsWith('/file/thumb/'))).toBe(true);
    expect(held.some((url) => !url.startsWith('/file/'))).toBe(true);
    const keys = await cachedKeys(other);
    const images = await cachedImages(other);
    for (const url of held) {
      expect(keys).not.toContain(url);
      expect(images).not.toContain(url);
    }
    expect(keys).not.toContain(`/wardrobe/${garmentId}`);
    expect(images.filter((url) => url.startsWith('/file/thumb/'))).toEqual([]);
  });

  /** The signed-in account's warm list and its id (X-Page-Account). */
  async function warmListOf(
    page: Page,
  ): Promise<{ list: WarmList; account: string }> {
    const res = await page.request.get(WARM_LIST_PATH);
    expect(res.ok()).toBe(true);
    const list = parseWarmList(await res.json());
    if (!list) throw new Error('not a warm list');
    return { list, account: res.headers()['x-page-account'] };
  }

  /**
   * Every warm fetch but the list goes out 100 ms late, so a warm is always
   * between fetches and in the middle of some. Once ten have gone (`midway`),
   * the next thumb is held (`held`) until `release` is called. The browser
   * sends each (route.fallback), with its own Sec-Fetch-Mode: route.fetch
   * would send none, and the gate would redirect it to the login page.
   */
  async function slowWarm(context: BrowserContext) {
    let sent = 0;
    let reachedMidway!: () => void;
    const midway = new Promise<void>((resolve) => (reachedMidway = resolve));
    let holding = false;
    let heldThumb!: (path: string) => void;
    const held = new Promise<string>((resolve) => (heldThumb = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      const warm =
        route.request().headers()[WARM_REQUEST_HEADER.toLowerCase()] !==
        undefined;
      if (!warm || url.pathname === WARM_LIST_PATH) {
        await route.fallback();
        return;
      }
      if (holding && url.pathname.startsWith('/file/thumb/')) {
        holding = false;
        heldThumb(url.pathname);
        await released;
      } else {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await route.fallback();
      sent += 1;
      if (sent === 10) {
        holding = true;
        reachedMidway();
      }
    });
    return { midway, held, release };
  }

  /** The accounts the cached pages were rendered for, records aside. */
  function cachedAccounts(page: Page): Promise<string[]> {
    return page.evaluate(async (cacheName) => {
      const cache = await caches.open(cacheName);
      const accounts: string[] = [];
      for (const key of await cache.keys()) {
        if (key.url.startsWith('https://page-cache.invalid/')) continue;
        const copy = await cache.match(key);
        accounts.push(copy?.headers.get('X-Page-Account') ?? '');
      }
      return accounts;
    }, PAGES_CACHE);
  }

  /** Nothing the warm list of `account` names is in either cache. */
  async function expectNothingOf(
    page: Page,
    { list, account }: { list: WarmList; account: string },
  ): Promise<void> {
    expect(await cachedAccounts(page)).not.toContain(account);
    const keys = await cachedKeys(page);
    for (const path of [...list.pages, ...list.fragments]) {
      if (!/^\/(?:wardrobe|outfits)\/\d+$|^\/wardrobe\/tiles/.test(path))
        continue;
      expect(keys).not.toContain(path);
    }
    const images = await cachedImages(page);
    for (const thumb of list.images) expect(images).not.toContain(thumb);
  }

  test('a session dropped between a warm’s fetches and during a thumb’s leaves nothing of the account (#286)', async ({
    page,
    context,
    playwright,
    browserName,
  }) => {
    test.skip(browserName === 'webkit', WEBKIT_CANNOT_WATCH_WORKER);
    await signInAs(page, await seedDemoAs('swr-dropwarm-a'));
    const first = await warmListOf(page);
    const second = await registerElsewhere(playwright, 'swr-dropwarm-b');
    const { midway, held, release } = await slowWarm(context);
    await page.goto('/auth/profile');
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.reload();
    await midway;
    // A thumb of this account's run is held before the account changes:
    // dropping first would let the run stop with none in flight (no
    // "answered from generation" line), or hold the next account's thumb.
    const heldPath = await held;

    // The other worker loop keeps starting fetches while the account
    // changes; the held thumb is in flight across the drop (the sign-out
    // post's), and the run ends once it lands.
    const other = await context.newPage();
    await other.goto('/auth/profile');
    await switchAccount(other, second);
    const refused = workerLogs(context, `${heldPath} answered from generation`);
    const stopped = workerLogs(
      context,
      '[sw] warm stopped, the session changed',
    );
    release();
    await refused;
    await stopped;

    await expectNothingOf(other, first);
  });

  test('a session revoked elsewhere mid-warm drops what the warm stored (#286)', async ({
    page,
    context,
    browser,
    browserName,
  }) => {
    test.skip(browserName === 'webkit', WEBKIT_CANNOT_WATCH_WORKER);
    const email = await seedDemoAs('swr-revokewarm');
    await signInAs(page, email);
    const warmed = await warmListOf(page);
    const { midway, release } = await slowWarm(context);
    release();
    await page.goto('/auth/profile');
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.reload();
    await midway;

    // The next page the warm asks for carries the revoked cookie: a 401
    // with X-Session-Ended, which drops the session caches.
    const ended = workerLogs(context, '(warm): the session ended');
    const stopped = workerLogs(context, '[sw] warm stopped, the session ended');
    const elsewhere = await changePasswordElsewhere(browser, email);
    await ended;
    await stopped;
    await elsewhere.close();

    await expectNothingOf(page, warmed);
    expect(await cachedImages(page)).toEqual([]);
  });
});
