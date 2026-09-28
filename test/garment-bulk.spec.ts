import { expect, test } from '@playwright/test';
import { SAME_ORIGIN, signIn } from './support/e2e-session';
import { pageErrors } from './support/page-errors';

/**
 * Select mode and bulk edit in a browser (#12, slice 12b): the live count,
 * the dialog's radio tabs (CSS only) choosing which value is posted, and
 * the native post landing back on the grid with its toast. The server side
 * is test/integration/garment-bulk.spec.ts.
 */

test.use({ viewport: { width: 390, height: 844 } });

test('select two tees, set them warm, and land back on the grid', async ({
  page,
}) => {
  const errors = pageErrors(page);
  await signIn(page, 'garment-bulk');
  for (const name of ['Tee one', 'Tee two', 'Boots']) {
    const res = await page.request.post('/wardrobe', {
      form: {
        name,
        category: name === 'Boots' ? 'footwear' : 'tops',
        props: '1',
      },
      headers: SAME_ORIGIN,
    });
    expect(res.ok()).toBe(true);
  }

  // Select is in the header's ⋯ menu (R3); select mode is a task with its
  // own bar.
  await page.goto('/wardrobe');
  await page.locator('#wardrobe-menu summary').click();
  await page
    .locator('#wardrobe-menu')
    .getByRole('link', { name: 'Select', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Select garments' }),
  ).toBeVisible();

  await page.getByRole('checkbox', { name: 'Tee one' }).check();
  await page.getByRole('checkbox', { name: 'Tee two' }).check();
  await expect(page.locator('#selected-count')).toHaveText('2');

  await page.getByRole('button', { name: 'Set…' }).click();
  const dialog = page.locator('#bulk-dialog');
  await expect(dialog).toBeVisible();
  // Warmth is the first tab; Sleeves shows its own chips when chosen.
  await dialog.getByRole('tab', { name: 'Sleeves' }).check();
  await expect(
    dialog.getByRole('radio', { name: 'Long sleeve' }),
  ).toBeVisible();
  await dialog.getByRole('tab', { name: 'Warmth' }).check();
  await expect(dialog.getByRole('radio', { name: 'Long sleeve' })).toBeHidden();
  await dialog.getByRole('radio', { name: 'Warm', exact: true }).check();
  await dialog.getByRole('button', { name: 'Apply' }).click();

  await expect(page).toHaveURL(/\/wardrobe(\?|$)/);
  await expect(page.getByText('Set on 2 garments')).toBeVisible();
  // The toast's flags are dropped from the address bar.
  await expect(page).not.toHaveURL(/bulkUpdated/);
  // Out of select mode: tiles are links again, filtering by warmth finds both.
  await page.goto('/wardrobe?warmth=4');
  await expect(page.locator('#wardrobe-grid > a')).toHaveCount(2);
  expect(errors).toEqual([]);
});
