import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import {
  parseWarmList,
  WARM_LIST_PATH,
  type WarmList,
} from '../src/web/shell/offline-warm';
import { createGarment } from './support/e2e-data';
import { SAME_ORIGIN, signIn, signInAs } from './support/e2e-session';
import { seedDemoAs } from './support/seed-demo';
import {
  ageCachedPage,
  ageLastWarm,
  cachedImages,
  cachedKeys,
  cachedPaths,
  networkSwitch,
  PAGES_CACHE,
  waitForServiceWorker,
  warmFinished,
  workerLogs,
} from './support/service-worker';
import { WEBKIT_CANNOT_WATCH_WORKER } from './support/webkit-limits';

/**
 * The installed app warms the account's whole wardrobe for offline reading
 * (#286, src/web/shell/offline-warm.md): once a day, after a page loads,
 * the worker fetches every page and thumb of GET /offline/warm it lacks.
 * The session cases (a sign-out, a sign-in, a drop mid-warm) are
 * stale-pages.spec.ts's; the list itself is
 * test/integration/offline-warm.spec.ts's.
 *
 * Needs a server started with PWA_ENABLED=true. Chromium only: offline goes
 * through networkSwitch, since setOffline does not cut the worker's own
 * fetches, and routing those (and reading the worker's console) is
 * Chromium's alone.
 */
test.describe('warming the wardrobe for offline reading', () => {
  test.skip(
    process.env.PWA_ENABLED !== 'true',
    'needs a server started with PWA_ENABLED=true',
  );
  test.skip(
    ({ browserName }) => browserName === 'firefox',
    'service workers are untested in Firefox here',
  );
  test.skip(
    ({ browserName }) => browserName === 'webkit',
    WEBKIT_CANNOT_WATCH_WORKER,
  );

  const DAY = 24 * 60 * 60_000;
  const TWO_HOURS = 2 * 60 * 60_000;

  async function warmListOf(page: Page): Promise<WarmList> {
    const res = await page.request.get(WARM_LIST_PATH);
    expect(res.ok()).toBe(true);
    const list = parseWarmList(await res.json());
    if (!list) throw new Error('not a warm list');
    return list;
  }

  /**
   * Opens the app until its first warm has run: the worker installs on the
   * first page, and whichever page loads once it controls them asks.
   */
  async function firstWarm(page: Page, context: BrowserContext) {
    const finished = warmFinished(context);
    await waitForServiceWorker(page);
    await page.goto('/outfits');
    return finished;
  }

  /**
   * Every cached page (pages-v2) made `ageMs` old, and the worker's
   * activation moved before them, as if warmed then by this build.
   */
  async function ageEveryPage(page: Page, ageMs: number): Promise<void> {
    await page.evaluate(
      async ({ cacheName, ageMs }) => {
        const cache = await caches.open(cacheName);
        const agedAt = String(Date.now() - ageMs);
        for (const key of await cache.keys()) {
          if (key.url.startsWith('https://page-cache.invalid/')) continue;
          const cached = (await cache.match(key))!;
          const headers = new Headers(cached.headers);
          headers.set('X-SW-Cached-At', agedAt);
          headers.set(
            'Server-Timing',
            (headers.get('Server-Timing') ?? '').replace(
              /cache;desc="\d+"/,
              `cache;desc="${agedAt}"`,
            ),
          );
          await cache.put(
            key,
            new Response(await cached.blob(), {
              status: cached.status,
              statusText: cached.statusText,
              headers,
            }),
          );
        }
        await cache.put(
          'https://page-cache.invalid/activated-at',
          new Response(String(Date.now() - ageMs - 60_000)),
        );
      },
      { cacheName: PAGES_CACHE, ageMs },
    );
  }

  /** Every /file image on the page has loaded (lazy ones made eager first). */
  async function expectPhotosShown(page: Page, path: string): Promise<void> {
    await page.evaluate(() => {
      for (const img of document.querySelectorAll('img[loading="lazy"]')) {
        (img as HTMLImageElement).loading = 'eager';
      }
    });
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            [...document.images]
              .filter((img) => new URL(img.src).pathname.startsWith('/file/'))
              .filter((img) => !img.complete || img.naturalWidth === 0)
              .map((img) => img.src),
          ),
        { message: `${path}: photos not shown` },
      )
      .toEqual([]);
  }

  test('the demo wardrobe reads offline after one warm, every page and thumb, under 10 MB', async ({
    page,
    context,
  }) => {
    test.setTimeout(300_000);
    await signInAs(page, await seedDemoAs('warm-demo'));
    const line = await firstWarm(page, context);
    expect(line).toMatch(
      /^\[sw\] warmed \d+ pages, \d+ images in [\d.]+ s \(\d+ fresh, 0 removed, 0 refused, 0 failed, added [\d.]+ MB, usage [\d.]+ MB of [\d.]+ [MG]B\)$/,
    );

    const list = await warmListOf(page);
    expect(list.pages.length).toBeGreaterThan(100);
    expect(list.fragments.length).toBeGreaterThan(0);
    const keys = await cachedKeys(page);
    for (const path of list.pages) expect(keys).toContain(path);
    for (const path of list.fragments) expect(keys).toContain(`${path}|hx`);
    expect(await cachedImages(page)).toEqual(
      expect.arrayContaining(list.images),
    );
    // No tab root is warmed: they open stale-while-revalidate, so they are
    // cached when opened (/outfits by firstWarm; /wardrobe's first load
    // came before the worker controlled the page).
    expect(keys).not.toContain('/wardrobe');
    expect(keys).not.toContain('/styling');
    expect(keys).not.toContain('/calendar');

    // The storage budget (docs/plans/2026-09-28-caching-and-offline.md,
    // section 2): the whole origin, precache included.
    const usage = await page.evaluate(
      async () => (await navigator.storage.estimate()).usage ?? 0,
    );
    console.info(
      `demo wardrobe warmed: ${(usage / 1024 / 1024).toFixed(1)} MB`,
    );
    expect(usage).toBeLessThan(10 * 1024 * 1024);

    // The grid's first page is a tab root: offline only once opened.
    await page.goto('/wardrobe');

    // Two hours on, offline: every page from the cache, saying how old it
    // is, with its photos (a cutout never viewed drawn from its thumb).
    await ageEveryPage(page, TWO_HOURS);
    const network = await networkSwitch(context);
    await network('offline');
    for (const path of list.pages) {
      const response = await page.goto(path);
      expect(response?.headers()['x-sw-cached-at'], path).toBeTruthy();
      await expect(page.locator('#freshness'), path).toHaveText(
        'Updated 2 hours ago',
      );
      await expectPhotosShown(page, path);
    }

    // The grid scrolled to its end: every later page from the cache.
    await page.goto('/wardrobe');
    const sentinel = page.locator('[data-wardrobe-more]');
    while ((await sentinel.count()) > 0) {
      const before = await page.locator('a[data-tile]').count();
      await sentinel.first().scrollIntoViewIfNeeded();
      await expect
        .poll(() => page.locator('a[data-tile]').count())
        .toBeGreaterThan(before);
    }
    const garmentPages = list.pages.filter((path) =>
      /^\/wardrobe\/\d+$/.test(path),
    );
    await expect(page.locator('a[data-tile]')).toHaveCount(garmentPages.length);
    await expectPhotosShown(page, '/wardrobe scrolled');

    // A tab root never opened: the offline page.
    await page.goto('/styling');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Offline.' }),
    ).toBeVisible();
  });

  test('warms at most once a day, then only what went stale, and drops a deleted garment’s page', async ({
    page,
    context,
  }) => {
    await signIn(page, 'warm-daily');
    const kept = await createGarment(page, 'Kept coat', 'coats');
    const deleted = await createGarment(page, 'Deleted coat', 'coats');

    // What reaches the server marked as a warm's (X-Closet-Warm).
    const warmed: string[] = [];
    await context.route('**/*', async (route) => {
      if (route.request().headers()['x-closet-warm']) {
        const url = new URL(route.request().url());
        warmed.push(`${url.pathname}${url.search}`);
      }
      await route.fallback();
    });

    await firstWarm(page, context);
    expect(warmed).toContain(WARM_LIST_PATH);
    expect(warmed).toContain(`/wardrobe/${deleted}`);
    expect(await cachedPaths(page)).toContain(`/wardrobe/${deleted}`);

    // Within the day: the next pages ask, and nothing is fetched.
    warmed.length = 0;
    const notDue = workerLogs(context, '[sw] warm not due');
    await page.goto('/calendar');
    await notDue;
    expect(warmed).toEqual([]);

    // A day on: one copy has gone stale, a garment was deleted.
    const response = await page.request.delete(`/wardrobe/${deleted}`, {
      headers: SAME_ORIGIN,
    });
    expect(response.ok()).toBe(true);
    await ageCachedPage(page, `/wardrobe/${kept}`, DAY + 60_000);
    await ageLastWarm(page, DAY + 60_000);
    const finished = warmFinished(context);
    await page.goto('/outfits');
    expect(await finished).toMatch(
      /\[sw\] warmed 1 pages, 0 images .* 1 removed/,
    );
    expect(warmed.sort()).toEqual([WARM_LIST_PATH, `/wardrobe/${kept}`]);
    const paths = await cachedPaths(page);
    expect(paths).not.toContain(`/wardrobe/${deleted}`);
    expect(paths).toContain(`/wardrobe/${kept}`);
  });

  test('a garment deleted after the list was made loses its cached page', async ({
    page,
    context,
  }) => {
    await signIn(page, 'warm-404');
    const deleted = await createGarment(page, 'Vanishing coat', 'coats');
    await firstWarm(page, context);
    expect(await cachedPaths(page)).toContain(`/wardrobe/${deleted}`);

    // Due again, and gone between the list and the page's own fetch.
    await ageCachedPage(page, `/wardrobe/${deleted}`, DAY + 60_000);
    await ageLastWarm(page, DAY + 60_000);
    await context.route(`**/wardrobe/${deleted}`, async (route) => {
      if (route.request().headers()['x-closet-warm']) {
        const response = await page.request.delete(`/wardrobe/${deleted}`, {
          headers: SAME_ORIGIN,
        });
        expect(response.ok()).toBe(true);
      }
      await route.fallback();
    });
    const finished = warmFinished(context);
    await page.goto('/outfits');
    expect(await finished).toMatch(/1 refused/);
    expect(await cachedPaths(page)).not.toContain(`/wardrobe/${deleted}`);
  });

  test('a new worker warms again within the day: the copies are an older build’s', async ({
    page,
    context,
  }) => {
    await signIn(page, 'warm-new-build');
    const coat = await createGarment(page, 'New build coat', 'coats');
    await firstWarm(page, context);

    // As if a new build's worker had activated after that warm.
    await page.evaluate(async (cacheName) => {
      const cache = await caches.open(cacheName);
      await cache.put(
        'https://page-cache.invalid/activated-at',
        new Response(String(Date.now())),
      );
    }, PAGES_CACHE);
    const finished = warmFinished(context);
    await page.goto('/calendar');
    expect(await finished).toMatch(/^\[sw\] warmed \d+ pages/);
    expect(await cachedPaths(page)).toContain(`/wardrobe/${coat}`);
  });

  test('a warm with a failed answer is not recorded: the next page warms again', async ({
    page,
    context,
  }) => {
    await signIn(page, 'warm-503');
    const coat = await createGarment(page, 'Unlucky coat', 'coats');
    let failing = true;
    await context.route(`**/wardrobe/${coat}`, async (route) => {
      if (failing && route.request().headers()['x-closet-warm']) {
        await route.fulfill({ status: 503, body: '' });
      } else await route.fallback();
    });
    expect(await firstWarm(page, context)).toMatch(
      /^\[sw\] warm incomplete, 1 failed: .* 1 failed,/,
    );
    expect(await cachedPaths(page)).not.toContain(`/wardrobe/${coat}`);

    failing = false;
    const finished = warmFinished(context);
    await page.goto('/calendar');
    expect(await finished).toMatch(/^\[sw\] warmed 1 pages, 0 images/);
    expect(await cachedPaths(page)).toContain(`/wardrobe/${coat}`);
  });
});
