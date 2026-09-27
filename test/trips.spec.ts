import { expect, type Page, test } from '@playwright/test';
import { addDays } from '../src/web/calendar/calendar-date';
import { createGarment } from './support/e2e-data';
import { SAME_ORIGIN, signIn } from './support/e2e-session';
import { householdToday } from './support/household-today';
import { waitForServiceWorker } from './support/service-worker';

/**
 * Trips (#10) at phone width, what only a browser shows: the trip form, the
 * destination found through the weather's search and its forecast loaded
 * into the page, an outfit added for a day, the packing list's and the
 * extras' checkboxes saved on change (htmx, the summary swapped out of
 * band), "Wearing this today", a gallery pick for the trip, nothing wider
 * than the phone, and, installed, the trip offline from the worker's copy
 * with its writes disabled. test/integration/trips.spec.ts has the behavior.
 */

test.use({ viewport: { width: 390, height: 844 } });

/** A tee (×3), jeans and sneakers, and an outfit of the three. */
async function closet(page: Page): Promise<{ outfit: number }> {
  const tee = await createGarment(page, 'Travel tee', 'tops', {
    care: '1',
    quantity: '3',
    color: 'grey',
  });
  const jeans = await createGarment(page, 'Travel jeans', 'bottoms', {
    color: 'blue',
  });
  const shoes = await createGarment(page, 'Travel sneakers', 'footwear', {
    color: 'white',
  });
  // One row per garment, as the builder posts them.
  const res = await page.request.post('/outfits', {
    headers: {
      ...SAME_ORIGIN,
      'content-type': 'application/x-www-form-urlencoded',
    },
    data: new URLSearchParams([
      ['name', 'Travel day'],
      ['category', 'tops'],
      ['garmentId', String(tee)],
      ['category', 'bottoms'],
      ['garmentId', String(jeans)],
      ['category', 'footwear'],
      ['garmentId', String(shoes)],
    ]).toString(),
  });
  expect(res.ok()).toBe(true);
  return { outfit: Number(new URL(res.url()).pathname.split('/').pop()) };
}

/** No element wider than the phone: the page never scrolls sideways. */
async function expectPhoneWidth(page: Page): Promise<void> {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
}

test.describe('Trips', () => {
  test('a trip from the form to a packed bag', async ({ page }) => {
    await signIn(page, 'trips');
    const { outfit } = await closet(page);
    const today = householdToday();

    // The Calendar's Trips tab, then the form.
    await page.goto('/calendar');
    await page.getByRole('tab', { name: 'Trips' }).click();
    await expect(page).toHaveURL(/\/trips$/);
    await page.getByRole('link', { name: 'New trip' }).first().click();
    await page.getByLabel('Name').fill('Austin conference');
    await page.getByLabel('Destination').fill('Austin');
    await page.getByLabel('First day').fill(today);
    await page.getByLabel('Last day').fill(addDays(today, 2));
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page).toHaveURL(/\/trips\/\d+$/);
    await expect(page.getByText('Trip created')).toBeVisible();
    await expect(page.locator('.dock a[aria-current="page"]')).toHaveAttribute(
      'href',
      '/calendar',
    );
    const tripUrl = page.url();

    // Found on the map: its forecast comes into the page.
    await page.getByRole('button', { name: 'Find', exact: true }).click();
    await page
      .getByRole('button', { name: 'Austin, Texas, United States' })
      .click();
    await expect(page).toHaveURL(tripUrl);
    await expect(page.locator('[data-trip-weather="forecast"]')).toBeVisible();
    await expect(page.locator('[data-weather-day]')).toHaveCount(3);

    // A saved outfit for today, from the add page.
    await page
      .locator(`[data-trip-day="${today}"]`)
      .locator('[data-add-outfit]')
      .click();
    await page.getByRole('button', { name: /Travel day/ }).click();
    await expect(
      page.locator(`[data-trip-day="${today}"] [data-trip-outfit]`),
    ).toHaveCount(1);
    await expectPhoneWidth(page);

    // The packing list: a checkbox saved on change, the summary out of band.
    await expect(page.locator('#trip-packed-summary')).toContainText(
      '0 of 3 packed',
    );
    await page.getByRole('checkbox', { name: /Travel tee/ }).check();
    await expect(page.locator('#trip-packed-summary')).toContainText(
      '1 of 3 packed',
    );
    await page.getByRole('checkbox', { name: /Travel jeans/ }).check();
    await expect(page.locator('#trip-packed-summary')).toContainText(
      '2 of 3 packed',
    );

    // Extras: added, then packed on change.
    await page.getByLabel('Charger, toiletries, passport…').fill('Charger');
    await page.getByRole('button', { name: 'Add', exact: true }).last().click();
    await page.getByRole('checkbox', { name: 'Charger' }).check();
    await expect(page.locator('#trip-items-summary')).toContainText(
      '1 of 1 packed',
    );

    // What the server kept.
    await page.reload();
    await expect(
      page.getByRole('checkbox', { name: /Travel tee/ }),
    ).toBeChecked();
    await expect(
      page.getByRole('checkbox', { name: /Travel sneakers/ }),
    ).not.toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Charger' })).toBeChecked();

    // "Wearing this today", through the calendar.
    await page.getByRole('button', { name: 'Wearing this today' }).click();
    await expect(page.getByText('Worn today')).toBeVisible();
    await page.goto(`/calendar?week=${today}`);
    await expect(
      page.locator(`a[href^="/outfits/${outfit}/edit"]`),
    ).toHaveCount(1);
  });

  test('ideas for a trip day land on the trip', async ({ page }) => {
    await signIn(page, 'trips-ideas');
    await closet(page);
    // The saved outfit is never an idea: another tee makes one.
    await createGarment(page, 'Spare tee', 'tops', { color: 'white' });
    const today = householdToday();
    const created = await page.request.post('/trips', {
      form: {
        name: 'Weekend away',
        startsOn: addDays(today, 1),
        endsOn: addDays(today, 2),
      },
      headers: SAME_ORIGIN,
    });
    expect(created.ok()).toBe(true);
    await page.goto(created.url());
    await page
      .locator(`[data-trip-day="${addDays(today, 1)}"]`)
      .getByRole('link', { name: 'Ideas' })
      .click();
    await expect(page).toHaveURL(/\/outfits\/ideas\?for=trip:\d+:/);
    await expect(page.getByText('For Weekend away')).toBeVisible();
    await page
      .locator('[data-idea]')
      .first()
      .getByRole('button', { name: 'Add to the trip' })
      .click();
    await expect(page).toHaveURL(/\/trips\/\d+$/);
    await expect(page.getByText('Added to the trip')).toBeVisible();
    await expect(
      page.locator(`[data-trip-day="${addDays(today, 1)}"] [data-trip-outfit]`),
    ).toHaveCount(1);
    await expectPhoneWidth(page);
  });
});

test.describe('A trip in the installed app', () => {
  test.skip(
    process.env.PWA_ENABLED !== 'true',
    'needs a server started with PWA_ENABLED=true',
  );
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'service workers are only reliable in chromium here',
  );

  test('offline, shows the last copy with its writes disabled', async ({
    page,
    context,
  }) => {
    await signIn(page, 'trips-offline');
    await closet(page);
    const today = householdToday();
    await waitForServiceWorker(page);
    const created = await page.request.post('/trips', {
      form: { name: 'Offline trip', startsOn: today, endsOn: today },
      headers: SAME_ORIGIN,
    });
    const url = new URL(created.url()).pathname;
    const online = await page.goto(url);
    expect(online?.fromServiceWorker()).toBe(true);

    await context.setOffline(true);
    await page.goto(url);
    await expect(
      page.getByRole('heading', { name: 'Offline trip' }),
    ).toBeVisible();
    await expect(page.locator('#connectivity-banner')).toBeVisible();
    await expect(page.locator('[data-offline-note]')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Add', exact: true }).last(),
    ).toBeDisabled();
    await context.setOffline(false);
  });
});
