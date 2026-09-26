import { expect, type Page, test } from '@playwright/test';
import { SAME_ORIGIN, signIn } from './support/e2e-session';

/**
 * The outfit builder in a browser: the htmx row swaps (the ‹ › arrows, the
 * remove button, "Add row") and public/js/outfit-builder.js, then saving, which must
 * keep the rows in the order they were left in. The integration tier covers
 * the server's side of each request; this proves the page wires them up.
 */

async function addGarment(page: Page, name: string, category: string) {
  const res = await page.request.post('/wardrobe', {
    form: { name, category },
    headers: SAME_ORIGIN,
  });
  expect(res.ok(), `create ${name}`).toBe(true);
}

test('build an outfit: step, remove and add rows, save, and see them in order', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await signIn(page, 'outfit-builder');
  await addGarment(page, 'Old tee', 'tops');
  await addGarment(page, 'New tee', 'tops');
  await addGarment(page, 'Jeans', 'bottoms');
  await addGarment(page, 'Boots', 'footwear');

  await page.goto('/outfits/new');
  const rows = page.locator('#outfit-rows-list .outfit-row');
  const categories = () =>
    rows.evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-category')),
    );
  const row = (category: string) =>
    page.locator(`.outfit-row[data-category="${category}"]`);

  // One row per category, built-in order, each on its newest garment.
  await expect(rows).toHaveCount(3);
  expect(await categories()).toEqual(['tops', 'bottoms', 'footwear']);
  await expect(row('tops').locator('.outfit-name')).toHaveText('New tee');

  // › swaps the row for the next (older) garment.
  await row('tops').getByRole('button', { name: 'Next garment' }).click();
  await expect(row('tops').locator('.outfit-name')).toHaveText('Old tee');

  // Remove the tops row, then add it back: it lands last.
  await row('tops').getByRole('button', { name: 'Remove row' }).click();
  await expect(rows).toHaveCount(2);
  await page.locator('#add-row-input').fill('tops');
  await page.getByRole('button', { name: 'Add row' }).click();
  await expect(rows).toHaveCount(3);
  expect(await categories()).toEqual(['bottoms', 'footwear', 'tops']);
  await expect(row('tops').locator('.outfit-name')).toHaveText('New tee');

  await page.locator('input[name="name"]').fill('Playwright look');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.waitForURL(/\/outfits\/\d+$/);

  // The detail page lists the garments in the order the rows were left in.
  await expect(page.locator('h1')).toHaveText('Playwright look');
  await expect(page.locator('main a[href^="/wardrobe/"]')).toHaveText([
    'Jeans',
    'Boots',
    'New tee',
  ]);

  // And the edit form restores that order.
  await page.goto(`${new URL(page.url()).pathname}/edit`);
  expect(await categories()).toEqual(['bottoms', 'footwear', 'tops']);

  expect(errors, errors.join('\n')).toEqual([]);
});
