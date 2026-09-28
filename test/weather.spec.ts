import { expect, type Page, test } from '@playwright/test';
import { createGarment, createOutfit } from './support/e2e-data';
import { SAME_ORIGIN, signIn } from './support/e2e-session';
import { householdToday } from './support/household-today';
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

/** Every month cell's box, rounded to the pixel. */
async function monthCellBoxes(page: Page): Promise<number[][]> {
  return page.locator('[data-month-day]').evaluateAll((cells) =>
    cells.map((cell) => {
      const box = cell.getBoundingClientRect();
      return [box.x, box.y, box.width, box.height].map(Math.round);
    }),
  );
}

test("the month grid's forecast days get their weather without moving (#201)", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await signIn(page, 'weather-month');
  await setHome(page);
  // Today holds a collage: the tallest kind of cell a chip joins.
  const today = householdToday();
  const tee = await createGarment(page, 'Month tee');
  await createOutfit(page, 'Month look', tee, today);

  // Keep the month's weather back until the grid has been measured.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/weather\/summary\?.*view=month/, async (route) => {
    await held;
    await route.continue();
  });
  const asked = page.waitForRequest(/\/weather\/summary\?.*view=month/);
  await page.goto('/calendar/month');
  await asked;
  await expect(page.locator('#weather-line')).toHaveCount(0);
  const before = await monthCellBoxes(page);

  release();
  const chip = page.locator(`[data-weather-day="${today}"]`);
  await expect(chip).toBeVisible();
  await expect(chip).toHaveText(/^\S+\s*-?\d+°$/);
  expect(await monthCellBoxes(page)).toEqual(before);

  // Days the forecast reaches only, and each chip inside its cell.
  const cell = page.locator(`[data-month-day="${today}"]`);
  const [chipBox, cellBox] = [
    await chip.boundingBox(),
    await cell.boundingBox(),
  ];
  expect(chipBox!.width).toBeLessThanOrEqual(cellBox!.width);
  const days = await page
    .locator('[data-weather-day]')
    .evaluateAll((chips) =>
      chips.map((one) => (one as HTMLElement).dataset.weatherDay ?? ''),
    );
  expect(days.length).toBeGreaterThan(0);
  expect(days.length).toBeLessThanOrEqual(16);
  for (const day of days) expect(day >= today, day).toBe(true);
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

test('"Use my location" can be tried again after its post fails', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 40.689167, longitude: -73.975556 });
  await signIn(page, 'weather-here-retry');
  await page.goto('/auth/profile');
  const settings = page.locator('#weather');
  const button = settings.getByRole('button', { name: 'Use my location' });

  // The connection drops as the position is sent: nothing is swapped in.
  await page.route('**/weather/here', (route) => route.abort());
  await button.click();
  await expect(settings.locator('[data-locate-status]')).toHaveText(
    'Your location could not be saved. Try again, or search your city.',
  );
  await expect(button).toBeEnabled();

  await page.unroute('**/weather/here');
  await button.click();
  await expect(settings).toContainText('Using your location from');
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
