import { type BrowserContext, expect, type Page } from '@playwright/test';

/** The worker's page cache (views/assets/src-sw.ts, PAGES_CACHE). */
export const PAGES_CACHE = 'pages-v2';

/** The worker's image cache (views/assets/src-sw.ts, IMAGES_CACHE). */
export const IMAGES_CACHE = 'images-v2';

/**
 * Takes the device off the network and puts it back. Chromium's setOffline
 * cuts the page's requests and the navigation preload but not a request the
 * worker makes itself (NetworkFirst for an htmx request, REVALIDATE_PAGE,
 * CacheFirst for an image), which the route fails meanwhile.
 */
export async function networkSwitch(context: BrowserContext) {
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
export function workerLogs(context: BrowserContext, text: string) {
  return context.waitForEvent('console', {
    predicate: (message) => message.text().includes(text),
    timeout: 15_000,
  });
}

/**
 * Loads /wardrobe and waits until the service worker controls the page, so
 * the next navigation goes through it. A freshly registered worker precaches
 * in the background first.
 */
export async function waitForServiceWorker(page: Page): Promise<void> {
  await page.goto('/wardrobe');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
}

/** The paths the page cache holds (pages and fragments alike). */
export function cachedPaths(page: Page): Promise<string[]> {
  return page.evaluate(async (cacheName) => {
    const cache = await caches.open(cacheName);
    return (await cache.keys()).map((request) => new URL(request.url).pathname);
  }, PAGES_CACHE);
}

/** Visits `path` through the worker until its page is in the cache. */
export async function cachePage(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect.poll(() => cachedPaths(page)).toContain(path);
}

/**
 * Makes the cached copy of `path` look `ageMs` old, as if the app had last
 * fetched it then: the stamp the worker writes, X-SW-Cached-At, and the same
 * stamp as its Server-Timing entry (page-cache.ts's CACHED_AT_TIMING_NAME;
 * freshness.js reads that one through Navigation Timing, #240), which must
 * age together or a full navigation reads the original, unaged stamp.
 */
export async function ageCachedPage(
  page: Page,
  path: string,
  ageMs: number,
): Promise<void> {
  await page.evaluate(
    async ({ cacheName, path, ageMs }) => {
      const cache = await caches.open(cacheName);
      const key = new URL(path, location.origin).href;
      const cached = await cache.match(key);
      if (!cached) throw new Error(`${path} is not cached`);
      const headers = new Headers(cached.headers);
      const agedAt = String(Date.now() - ageMs);
      headers.set('X-SW-Cached-At', agedAt);
      const timing = headers.get('Server-Timing') ?? '';
      headers.set(
        'Server-Timing',
        timing.replace(/cache;desc="\d+"/, `cache;desc="${agedAt}"`),
      );
      await cache.put(
        key,
        new Response(await cached.blob(), {
          status: cached.status,
          statusText: cached.statusText,
          headers,
        }),
      );
    },
    { cacheName: PAGES_CACHE, path, ageMs },
  );
}
