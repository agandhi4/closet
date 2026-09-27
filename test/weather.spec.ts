import { expect, type Page, test } from '@playwright/test';
import { SAME_ORIGIN, signIn } from './support/e2e-session';
import {
  cachedPaths,
  cachePage,
  waitForServiceWorker,
} from './support/service-worker';

/**
 * Weather at phone width (#14): the profile's city search and "Use my
 * location", today's line on the wardrobe and the chips on the calendar,
 * and, with the service worker, the cached line offline with the time it
 * was fetched. The forecast is the test server's stand-in for Open-Meteo
 * (test/support/weather-stub.ts); the server side is
 * test/integration/weather.spec.ts.
 */

test.use({ viewport: { width: 390, height: 844 } });

async function setHome(page: Page): Promise<void> {
  const res = await page.request.post('/weather/home', {
    form: {
      name: 'Brooklyn, New York, United States',
      latitude: '40.65',
      longitude: '-73.95',
    },
    headers: SAME_ORIGIN,
    maxRedirects: 0,
  });
  expect(res.status()).toBe(303);
}

/** Nothing wider than the screen: the dock and the header fit at 390 px. */
async function expectNoSideScroll(page: Page): Promise<void> {
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);
}

test('a city from the search, then the line and the week', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await signIn(page, 'weather-city');

  await page.goto('/wardrobe');
  const prompt = page.getByRole('link', {
    name: 'Add your city for the weather',
  });
  await expect(prompt).toBeVisible();
  await prompt.click();

  const settings = page.locator('#weather');
  await settings.getByRole('searchbox').fill('Brooklyn');
  await settings.getByRole('button', { name: 'Search' }).click();
  await settings
    .getByRole('button', { name: 'Brooklyn, New York, United States' })
    .click();
  await expect(settings).toContainText(
    'Home: Brooklyn, New York, United States',
  );
  await settings.getByRole('radio', { name: '°F' }).check();
  await expect(settings.getByRole('radio', { name: '°F' })).toBeChecked();

  await page.getByRole('link', { name: 'Wardrobe', exact: true }).click();
  const line = page.locator('p#weather-line');
  await expect(line).toContainText('°F');
  await expect(line).toContainText('Brooklyn · as of');
  await expectNoSideScroll(page);

  await page.goto('/calendar');
  await expect(page.locator('[data-weather-day]')).not.toHaveCount(0);
  await expectNoSideScroll(page);
  expect(errors).toEqual([]);
});

test('"Use my location" sends the rounded position and says until when', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 40.689167, longitude: -73.975556 });
  await signIn(page, 'weather-here');
  await page.goto('/auth/profile');
  const settings = page.locator('#weather');
  const posted = page.waitForRequest(
    (request) =>
      request.url().endsWith('/weather/here') && request.method() === 'POST',
  );
  await settings.getByRole('button', { name: 'Use my location' }).click();
  expect((await posted).postData()).toBe('latitude=40.69&longitude=-73.98');
  await expect(settings).toContainText('Using your location from');
  await settings
    .getByRole('button', { name: 'Stop using my location' })
    .click();
  await expect(
    settings.getByRole('button', { name: 'Use my location' }),
  ).toBeVisible();
});

test.describe('offline', () => {
  test.skip(
    process.env.PWA_ENABLED !== 'true',
    'needs a server started with PWA_ENABLED=true',
  );
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'service workers are only reliable in chromium here',
  );

  test('the cached line, with the time it was fetched', async ({
    page,
    context,
  }) => {
    await signIn(page, 'weather-offline');
    await setHome(page);
    await waitForServiceWorker(page);
    await cachePage(page, '/wardrobe');

    await page.goto('/wardrobe');
    const line = page.locator('p#weather-line');
    await expect(line).toContainText('as of');
    const online = (await line.textContent()) ?? '';
    // The line is its own htmx request, cached by the worker like a page
    // (under `url|hx`, src/htmx/fragment-request.ts).
    await expect
      .poll(() => cachedPaths(page))
      .toContainEqual(expect.stringMatching(/^\/weather\/summary/));

    await context.setOffline(true);
    await page.goto('/wardrobe');
    await expect(page.locator('#connectivity-banner')).toBeVisible();
    await expect(line).toHaveText(online);
    await context.setOffline(false);
  });
});
