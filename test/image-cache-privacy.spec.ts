import { expect, type Page, test } from '@playwright/test';
import sharp from 'sharp';
import { createOutfit } from './support/e2e-data';
import {
  registerElsewhere,
  SAME_ORIGIN,
  signIn,
  switchAccount,
} from './support/e2e-session';
import { householdToday } from './support/household-today';
import {
  cachedPaths,
  cachePage,
  IMAGES_CACHE,
  networkSwitch,
  waitForServiceWorker,
  workerLogs,
} from './support/service-worker';

/**
 * The service worker's image cache is the session's, like its page cache
 * (#226, views/assets/src-sw.ts SESSION_CACHES): signing out, signing in and
 * a page for another account drop it, and a photo fetched for the previous
 * account that lands after the drop is never stored. Outfit selfies are never
 * in any of the worker's caches, even opened as a document. The page cache's
 * own cases are stale-pages.spec.ts and session-revocation.spec.ts.
 *
 * Needs a server started with PWA_ENABLED=true; Chromium only, like
 * stale-pages.spec.ts. Offline goes through networkSwitch: setOffline alone
 * does not cut the worker's own fetches.
 */
test.describe('the image cache belongs to one session', () => {
  test.skip(
    process.env.PWA_ENABLED !== 'true',
    'needs a server started with PWA_ENABLED=true',
  );
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'service workers are only reliable in chromium here',
  );

  /** A garment with a photo, made through the app's own posts; its id. */
  async function addPhotographedGarment(
    page: Page,
    name: string,
  ): Promise<number> {
    const created = await page.request.post('/wardrobe', {
      form: { name, category: 'coats' },
      headers: SAME_ORIGIN,
    });
    expect(created.ok()).toBe(true);
    const garmentId = Number(new URL(created.url()).pathname.split('/').pop());
    const uploaded = await page.request.post(`/wardrobe/${garmentId}/photo`, {
      multipart: {
        photo: {
          name: 'coat.jpg',
          mimeType: 'image/jpeg',
          buffer: await sharp({
            create: {
              width: 800,
              height: 600,
              channels: 3,
              background: '#6a4',
            },
          })
            .jpeg()
            .toBuffer(),
        },
      },
      headers: SAME_ORIGIN,
    });
    expect(uploaded.ok()).toBe(true);
    return garmentId;
  }

  /**
   * The photo's thumb, cutout and original, from its tile on the wardrobe
   * page open in `page`: the signed URLs the page itself requests (#162).
   * A photo's three URLs differ only in their path (imageUrl signs the set,
   * not the variant), so the path swap gives the exact URLs the garment page
   * and the mask editor load, which is what the worker caches by.
   */
  async function photoUrls(page: Page): Promise<string[]> {
    const thumb = await page
      .locator('#wardrobe-grid > a img')
      .getAttribute('src');
    expect(thumb).toMatch(
      /^\/file\/thumb\/[0-9a-f-]+\.webp\?v=\d+(&k=[0-9a-f]{12})?&s=[A-Za-z0-9_-]{16}$/,
    );
    return [
      thumb!,
      thumb!.replace('/file/thumb/', '/file/nobg/'),
      thumb!.replace('/file/thumb/', '/file/'),
    ];
  }

  /** Loads each URL as an <img>; whether each one showed. */
  function loadImages(page: Page, urls: string[]): Promise<boolean[]> {
    return page.evaluate(
      (targets) =>
        Promise.all(
          targets.map(
            (src) =>
              new Promise<boolean>((resolve) => {
                const img = new Image();
                img.onload = () => resolve(img.naturalWidth > 0);
                img.onerror = () => resolve(false);
                img.src = src;
              }),
          ),
        ),
      urls,
    );
  }

  /** The URLs any Cache Storage cache of this origin holds a copy of. */
  function cachedAnywhere(page: Page, urls: string[]): Promise<string[]> {
    return page.evaluate(async (targets) => {
      const found: string[] = [];
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const url of targets) {
          if (await cache.match(url, { ignoreSearch: true })) {
            found.push(`${name} ${url}`);
          }
        }
      }
      return found;
    }, urls);
  }

  /** The image cache's keys, path and query. */
  function cachedImages(page: Page): Promise<string[]> {
    return page.evaluate(async (cacheName) => {
      const cache = await caches.open(cacheName);
      return (await cache.keys()).map((request) => {
        const url = new URL(request.url);
        return `${url.pathname}${url.search}`;
      });
    }, IMAGES_CACHE);
  }

  /** Loads the photos through the worker until the image cache holds them. */
  async function cacheImages(page: Page, urls: string[]): Promise<void> {
    expect(await loadImages(page, urls)).toEqual(urls.map(() => true));
    await expect
      .poll(() => cachedImages(page))
      .toEqual(expect.arrayContaining(urls));
  }

  /** Takes a selfie from Today's planned card; the thumb's URL. */
  async function takeSelfie(page: Page, garmentId: number): Promise<string> {
    await createOutfit(page, 'Dinner', garmentId, householdToday());
    await page.goto('/');
    const card = page.locator('[data-today-row="planned"] article');
    await card.getByLabel('Choose a photo').setInputFiles({
      name: 'mirror.jpg',
      mimeType: 'image/jpeg',
      buffer: await sharp({
        create: { width: 600, height: 800, channels: 3, background: '#a58d74' },
      })
        .jpeg()
        .toBuffer(),
    });
    const thumb = card.locator('img[src^="/selfies/thumb/"]');
    await expect
      .poll(() => thumb.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);
    return (await thumb.getAttribute('src'))!;
  }

  test('after signing out and in as another account, none of the first one’s photos is served, offline included', async ({
    page,
    context,
    playwright,
  }) => {
    await signIn(page, 'img-first');
    const garmentId = await addPhotographedGarment(page, 'Private coat');
    await waitForServiceWorker(page);
    const network = await networkSwitch(context);
    await cachePage(page, '/wardrobe');
    const photos = await photoUrls(page);
    await cacheImages(page, photos);

    // A selfie is its owner's alone: the worker keeps none, neither its
    // <img> loads nor the photo opened as a document, which is no page and
    // must not claim the page cache for nobody (dropping the account's
    // pages) either.
    const selfieThumb = await takeSelfie(page, garmentId);
    const selfie = selfieThumb.replace('/selfies/thumb/', '/selfies/');
    const opened = await page.goto(selfie);
    expect(opened?.headers()['content-type']).toBe('image/webp');
    await cachePage(page, '/about');
    expect(await cachedPaths(page)).toContain('/wardrobe');
    const selfies = [selfieThumb, selfie];
    expect(await cachedAnywhere(page, selfies)).toEqual([]);

    await switchAccount(
      page,
      await registerElsewhere(playwright, 'img-second'),
    );
    await expect.poll(() => cachedAnywhere(page, photos)).toEqual([]);

    await network('offline');
    const everything = [...photos, ...selfies];
    expect(await loadImages(page, everything)).toEqual(
      everything.map(() => false),
    );
    expect(await cachedAnywhere(page, everything)).toEqual([]);
  });

  test('a page for another account, from a sign-in the worker never saw, drops the photos', async ({
    page,
    context,
  }) => {
    await signIn(page, 'img-unseen-a');
    await addPhotographedGarment(page, 'Unseen coat');
    await waitForServiceWorker(page);
    const network = await networkSwitch(context);
    await page.goto('/wardrobe');
    const photos = await photoUrls(page);
    await cacheImages(page, photos);

    // The API context shares the cookies, not the worker: no sign-in post
    // passes through it. The new account's first page (X-Page-Account) is
    // how it learns.
    await signIn(page, 'img-unseen-b');
    await page.goto('/outfits');
    await expect.poll(() => cachedAnywhere(page, photos)).toEqual([]);

    await network('offline');
    expect(await loadImages(page, photos)).toEqual(photos.map(() => false));
    expect(await cachedAnywhere(page, photos)).toEqual([]);
  });

  test('a photo for the previous account that lands after the switch is never stored', async ({
    page,
    context,
    playwright,
  }) => {
    await signIn(page, 'img-race-a');
    await addPhotographedGarment(page, 'Race coat');
    const second = await registerElsewhere(playwright, 'img-race-b');
    await waitForServiceWorker(page);
    const network = await networkSwitch(context);
    const photos = await photoUrls(page);
    const original = photos[2];
    const originalPath = original.split('?')[0];

    // The worker's fetch of the first account's photo is answered at once
    // by the server, and reaches the worker only after another tab has
    // switched accounts. Held once (the offline load below must fail);
    // registered after networkSwitch, so it goes first.
    let held = false;
    let answered!: () => void;
    const fetched = new Promise<void>((resolve) => (answered = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    await context.route(
      (url) => url.pathname === originalPath,
      async (route) => {
        if (held) {
          await route.fallback();
          return;
        }
        held = true;
        const response = await route.fetch();
        answered();
        await released;
        await route.fulfill({ response });
      },
    );
    await page.evaluate((src) => {
      const img = new Image();
      img.src = src;
      document.body.append(img);
    }, original);
    await fetched;

    const other = await context.newPage();
    await other.goto('/auth/profile');
    await switchAccount(other, second);
    await network('offline');

    const refused = workerLogs(
      context,
      `${originalPath} answered from generation`,
    );
    release();
    await refused;

    expect(await cachedAnywhere(other, photos)).toEqual([]);
    expect(await loadImages(other, [original])).toEqual([false]);
  });
});
