import { expect, type Page, test } from '@playwright/test';
import { SAME_ORIGIN, signIn } from './support/e2e-session';

/**
 * What _hyperscript used to do, done by htmx attributes, inline handlers,
 * CSS and public/js/outfit-builder.js since it left the app: the wardrobe
 * filter form, the builder's swipe and detail dialog, the outfit list's
 * "add to calendar" toast, the share link's copy button and the garment
 * page's self-hiding toast. The outfit builder spec covers the arrows,
 * remove and "Add row".
 */

async function createGarment(
  page: Page,
  name: string,
  category: string,
  fields: Record<string, string> = {},
): Promise<number> {
  const res = await page.request.post('/wardrobe', {
    form: { name, category, ...fields },
    headers: SAME_ORIGIN,
  });
  expect(res.ok()).toBe(true);
  return Number(new URL(res.url()).pathname.split('/').pop());
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  return errors;
}

test('the filter modal applies and clears filters, keeping the keyword', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await signIn(page, 'client-filters');
  await createGarment(page, 'Red tee', 'tops', { color: 'red' });
  await createGarment(page, 'Blue tee', 'tops', { color: 'blue' });
  await createGarment(page, 'Red scarf', 'scarves', { color: 'red' });
  await page.goto('/wardrobe');
  const tiles = page.locator('#wardrobe-grid > a.card');
  await expect(tiles).toHaveCount(3);

  await page.getByRole('textbox', { name: 'Search' }).fill('tee');
  await page.getByRole('button', { name: 'Filter Search' }).click();
  const modal = page.locator('#filter-modal');
  await expect(modal).toBeVisible();
  await modal.getByText('red', { exact: true }).click();
  await modal.getByRole('button', { name: 'Apply Filters' }).click();

  await expect(page).toHaveURL(/color=red/);
  await expect(page).toHaveURL(/keyword=tee/);
  await expect(tiles).toHaveCount(1);
  await expect(tiles.first()).toContainText('Red tee');
  await expect(modal).toBeHidden();

  await page.getByRole('button', { name: 'Filter Search' }).click();
  await modal.getByRole('button', { name: 'Clear Filters' }).click();
  await expect(page).not.toHaveURL(/color=/);
  await expect(tiles).toHaveCount(2);
  expect(errors).toEqual([]);
});

test('the builder: a swipe steps a row, a tap opens the garment dialog', async ({
  browser,
}) => {
  const context = await browser.newContext({ hasTouch: true });
  const page = await context.newPage();
  const errors = collectErrors(page);
  await signIn(page, 'client-builder');
  await createGarment(page, 'Old tee', 'tops', { brand: 'Acme' });
  await createGarment(page, 'New tee', 'tops');
  await page.goto('/outfits/new');
  const row = page.locator('.outfit-row[data-category="tops"]');
  await expect(row.locator('.outfit-name')).toHaveText('New tee');

  // A leftward swipe is "next" (older).
  await row.evaluate((el) => {
    const touch = (x: number) =>
      new Touch({ identifier: 1, target: el, clientX: x, clientY: 100 });
    el.dispatchEvent(
      new TouchEvent('touchstart', {
        bubbles: true,
        touches: [touch(200)],
        changedTouches: [touch(200)],
      }),
    );
    el.dispatchEvent(
      new TouchEvent('touchend', {
        bubbles: true,
        touches: [],
        changedTouches: [touch(120)],
      }),
    );
  });
  await expect(row.locator('.outfit-name')).toHaveText('Old tee');

  await row.locator('button[data-garment-href]').click();
  const dialog = page.locator('#garment-modal');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('#modal-garment-name')).toHaveText('Old tee');
  await expect(dialog.locator('#modal-brand')).toHaveText('Acme');
  await expect(dialog.locator('#modal-size')).toBeHidden();
  expect(errors).toEqual([]);
  await context.close();
});

test('scheduling from an outfit card closes the dropdown and shows the toast', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await signIn(page, 'client-schedule');
  const garment = await createGarment(page, 'Toast tee', 'tops');
  const res = await page.request.post('/outfits', {
    form: { name: 'Toast outfit', category: 'tops', garmentId: `${garment}` },
    headers: SAME_ORIGIN,
  });
  expect(res.ok()).toBe(true);
  await page.goto('/outfits');

  await page.getByTitle('Add to Calendar').click();
  const form = page.locator('form[data-schedule]');
  await form.locator('input[name="date"]').fill('2030-10-10');
  await form.getByRole('button', { name: 'Save' }).click();

  await expect(page.locator('#calendar-toast')).toBeVisible();
  await expect(form.locator('input[name="date"]')).toHaveValue('');
  await expect(page.locator('#calendar-toast')).toBeHidden({ timeout: 5000 });
  expect(errors).toEqual([]);
});

test('the share button copies the link and flashes', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await signIn(page, 'client-share');
  const id = await createGarment(page, 'Shared tee', 'tops');
  await page.goto(`/wardrobe/${id}`);

  const share = page.getByRole('button', { name: 'Share' });
  await share.click();
  await expect(share).toHaveClass(/\bbtn-success\b/);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
    /\/share\?shareableId=[^&]+&type=garment$/,
  );
  await expect(share).toHaveClass(/\bbtn-outline\b/);
});

test('the "saved" toast hides itself', async ({ page }) => {
  await signIn(page, 'client-toast');
  const id = await createGarment(page, 'Toasted tee', 'tops');
  await page.goto(`/wardrobe/${id}?created=1`);
  const toast = page.locator('#garment-saved-toast');
  await expect(toast).toBeVisible();
  await expect(toast).toBeHidden({ timeout: 6000 });
});
