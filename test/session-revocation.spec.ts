import { expect, type Page, test } from '@playwright/test';
import sharp from 'sharp';
import { createGarment, createOutfit } from './support/e2e-data';
import { changePasswordElsewhere, signIn } from './support/e2e-session';
import { householdToday } from './support/household-today';
import {
  cachedPaths,
  cachePage,
  waitForServiceWorker,
} from './support/service-worker';

/**
 * A session ended on another device (here a password change) leaves nothing
 * private behind on this one: its next request comes back with the cookie
 * cleared and `Clear-Site-Data: "cache"` (the session resolver,
 * src/web/auth/session.ts), so the selfie it had in its HTTP cache is gone,
 * and with the PWA on, a boosted tap that lands on the login page drops the
 * worker's page cache (sentToLogin, views/assets/src-sw.ts). The headers on
 * every revocation path are test/integration/session-revocation.spec.ts.
 *
 * Chromium only: `cache: 'only-if-cached'` is how a page asks the HTTP cache
 * alone, and Clear-Site-Data's effect is what is measured.
 */
test.describe('a session revoked elsewhere', () => {
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'reads the HTTP cache with only-if-cached, in chromium',
  );

  /** Whether the browser's HTTP cache alone can answer `url`. */
  const inHttpCache = (page: Page, url: string) =>
    page.evaluate(async (target) => {
      try {
        const res = await fetch(target, {
          cache: 'only-if-cached',
          mode: 'same-origin',
        });
        return res.ok;
      } catch {
        return false;
      }
    }, url);

  test('the next request clears the cookie and the cached selfie; the other device stays signed in', async ({
    page,
    browser,
  }) => {
    const email = await signIn(page, 'revoked-selfie');
    const shirt = await createGarment(page, 'Linen shirt');
    await createOutfit(page, 'Dinner', shirt, householdToday());

    // A selfie taken from Today, shown there, so its bytes are cached.
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
    const selfieUrl = (await thumb.getAttribute('src'))!;
    expect(await inHttpCache(page, selfieUrl)).toBe(true);

    const other = await changePasswordElsewhere(browser, email);

    // This device's next navigation is sent to log in, signed out and with
    // the account's cache gone.
    await page.goto('/wardrobe');
    await expect(page).toHaveURL(/\/auth\/login$/);
    const cookies = await page.context().cookies();
    expect(cookies.find((c) => c.name === 'access_token')).toBeUndefined();
    expect(await inHttpCache(page, selfieUrl)).toBe(false);

    // The device that changed the password is still signed in.
    const profile = await other.request.get('/auth/profile', {
      maxRedirects: 0,
    });
    expect(profile.status()).toBe(200);
    await other.close();
  });

  test('a boosted tap that lands on the login page drops the worker’s page cache', async ({
    page,
    browser,
  }) => {
    test.skip(
      process.env.PWA_ENABLED !== 'true',
      'needs a server started with PWA_ENABLED=true',
    );
    const email = await signIn(page, 'revoked-pages');
    await waitForServiceWorker(page);
    await cachePage(page, '/wardrobe');
    await cachePage(page, '/calendar');

    const other = await changePasswordElsewhere(browser, email);

    // An in-app tap: htmx's request follows the redirect to the login page.
    await page.locator('.dock a[href="/outfits"]').click();
    await expect(page.locator('form[action="/auth/login"]')).toBeVisible();
    await expect
      .poll(() => cachedPaths(page))
      .not.toEqual(expect.arrayContaining(['/wardrobe']));
    const left = await cachedPaths(page);
    expect(left).not.toContain('/calendar');
    await other.close();
  });
});
