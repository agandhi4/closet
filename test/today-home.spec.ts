import { expect, type Page, test } from '@playwright/test';
import { createGarment, createOutfit } from './support/e2e-data';
import { signIn } from './support/e2e-session';
import { householdToday } from './support/household-today';
import { waitForServiceWorker } from './support/service-worker';
import { WEBKIT_CANNOT_NAVIGATE_OFFLINE } from './support/webkit-limits';

/**
 * Today (#15) at phone width, what only a browser shows: the home screen
 * with its ideas strip above the dock, "Wear this" landing back on Today
 * worn, Refresh swapping the row in place, a planned outfit's Change
 * putting an idea in its place (#69), and, installed, Today offline
 * from the worker's last copy with its writes disabled
 * (test/integration/today-home.spec.ts has the behavior; a push arriving on
 * an installed phone is the PR's manual check).
 */

test.use({ viewport: { width: 390, height: 844 } });

/** A closet of 3 tops, 2 bottoms and shoes: ideas enough for two pages. */
async function closet(page: Page): Promise<void> {
  for (const [name, category, color] of [
    ['White tee', 'tops', 'white'],
    ['Grey tee', 'tops', 'grey'],
    ['Black tee', 'tops', 'black'],
    ['Jeans', 'bottoms', 'blue'],
    ['Chinos', 'bottoms', 'beige'],
    ['Sneakers', 'footwear', 'white'],
  ]) {
    await createGarment(page, name, category, {
      props: '1',
      formality: '2',
      pattern: 'solid',
      color,
    });
  }
}

const cards = (page: Page) => page.locator('[data-idea]');

test.describe('Today', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, 'today');
    await closet(page);
  });

  test('opens on the day with three ideas, and "Wear this" wears one', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(
      page.locator('[data-today-row="ideas"][data-occasion="all-day"]'),
    ).toBeVisible();
    await expect(cards(page)).toHaveCount(3);
    await expect(page.locator('.dock a[aria-current="page"]')).toHaveAttribute(
      'href',
      '/',
    );
    // The first card's action is above the dock, not under it.
    const wear = cards(page).first().getByRole('button', { name: 'Wear this' });
    const [button, dock] = await Promise.all([
      wear.boundingBox(),
      page.locator('.dock').boundingBox(),
    ]);
    expect(button!.y + button!.height).toBeLessThanOrEqual(dock!.y);

    await wear.click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText('Worn today')).toBeVisible();
    await expect(page.locator('[data-today-row="ideas"]')).toHaveCount(0);
  });

  test('Change puts an idea in the planned outfit’s place: still one outfit for the occasion', async ({
    page,
  }) => {
    const day = householdToday();
    const shirt = await createGarment(page, 'Linen shirt', 'tops', {
      props: '1',
      formality: '2',
      pattern: 'solid',
      color: 'white',
    });
    await createOutfit(page, 'Planned look', shirt, day);
    await page.goto('/');
    const planned = page.locator('[data-today-row="planned"] article');
    await expect(planned).toHaveCount(1);
    await expect(planned.locator('h3')).toHaveText('Planned look');

    // At phone width the card and its actions fit the screen.
    const change = planned.getByRole('link', { name: 'Change' });
    const box = (await change.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);

    await change.click();
    await expect(page).toHaveURL(/\/outfits\/ideas\?for=day:.*&replace=\d+/);
    await page
      .getByRole('button', { name: 'Wear this instead' })
      .first()
      .click();
    await expect(page).toHaveURL(new RegExp(`/calendar\\?week=${day}$`));
    await expect(page.locator('[data-occasion="all-day"]')).toHaveCount(1);

    await page.goto('/');
    await expect(planned).toHaveCount(1);
    await expect(planned.locator('h3')).not.toHaveText('Planned look');
  });

  test('Refresh swaps the ideas in place', async ({ page }) => {
    await page.goto('/');
    const first = await cards(page).first().getAttribute('data-idea');
    await page.evaluate(() => {
      (window as Window & { __sameDocument?: boolean }).__sameDocument = true;
    });
    await page.getByRole('button', { name: 'Show other ideas' }).click();
    await expect(page.locator('[data-today-row="ideas"]')).toHaveAttribute(
      'data-page',
      '2',
    );
    await expect(cards(page).first()).not.toHaveAttribute('data-idea', first!);
    expect(
      await page.evaluate(
        () => (window as Window & { __sameDocument?: boolean }).__sameDocument,
      ),
    ).toBe(true);
  });
});

test.describe('Today in the installed app', () => {
  test.skip(
    process.env.PWA_ENABLED !== 'true',
    'needs a server started with PWA_ENABLED=true',
  );
  test.skip(
    ({ browserName }) => browserName === 'webkit',
    WEBKIT_CANNOT_NAVIGATE_OFFLINE,
  );
  test.skip(
    ({ browserName }) => browserName === 'firefox',
    'service workers are untested in Firefox here',
  );

  test('offline, shows the last copy with its writes disabled', async ({
    page,
    context,
  }) => {
    await signIn(page, 'today-offline');
    await closet(page);
    await waitForServiceWorker(page);
    // Network first: this visit is the copy the worker keeps.
    const online = await page.goto('/');
    expect(online?.fromServiceWorker()).toBe(true);
    await expect(cards(page)).toHaveCount(3);

    await context.setOffline(true);
    await page.goto('/');
    await expect(cards(page)).toHaveCount(3);
    await expect(page.locator('#connectivity-banner')).toBeVisible();
    await expect(page.locator('[data-offline-note]')).toBeVisible();
    await expect(
      cards(page).first().getByRole('button', { name: 'Wear this' }),
    ).toBeDisabled();
    await context.setOffline(false);
  });
});
