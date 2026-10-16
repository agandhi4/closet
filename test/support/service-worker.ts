import { type BrowserContext, expect, type Page } from '@playwright/test';

/** The worker's page cache (views/assets/src-sw.ts, PAGES_CACHE). */
const PAGES_CACHE = 'pages-v2';

/** The worker's image cache (views/assets/src-sw.ts, IMAGES_CACHE). */
const IMAGES_CACHE = 'images-v2';

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

/** The images the worker's image cache holds, as path and query. */
export function cachedImages(page: Page): Promise<string[]> {
  return page.evaluate(async (cacheName) => {
    const cache = await caches.open(cacheName);
    return (await cache.keys()).map((request) => {
      const url = new URL(request.url);
      return `${url.pathname}${url.search}`;
    });
  }, IMAGES_CACHE);
}

/**
 * The context's pages never post WARM_PAGES (pwa.js, #286), so the worker
 * never warms the wardrobe. For a spec whose cache contents or offline
 * pages are its own visits' alone: a warm running beside it would fill the
 * caches with every page and thumb. The message itself is held back, not a
 * record in the cache: every sign-in drops the caches, and the next page
 * would warm again.
 */
export async function withoutWarming(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const post = Reflect.get(ServiceWorker.prototype, 'postMessage') as (
      ...args: unknown[]
    ) => void;
    ServiceWorker.prototype.postMessage = function (
      this: ServiceWorker,
      message: unknown,
      ...rest: unknown[]
    ) {
      const type = (message as { type?: unknown } | null)?.type;
      if (type === 'WARM_PAGES') return;
      Reflect.apply(post, this, [message, ...rest]);
    };
  });
}
