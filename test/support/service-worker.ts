import { expect, type Page } from '@playwright/test';

/** The worker's page cache (views/assets/src-sw.ts, PAGES_CACHE). */
export const PAGES_CACHE = 'pages-v2';

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
 * fetched it then (the stamp the worker writes, X-SW-Cached-At).
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
      headers.set('X-SW-Cached-At', String(Date.now() - ageMs));
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
