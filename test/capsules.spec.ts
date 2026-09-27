import { expect, test } from '@playwright/test';
import { SAME_ORIGIN, signIn } from './support/e2e-session';

/**
 * Capsules in a browser at phone width (#8): the Capsules tab, creating a
 * capsule, choosing its garments in the picker (the grid's select mode:
 * members pre-checked, the live count, the native Save landing on the
 * capsule with its toast), and the garment page's toggles saving on tap
 * through htmx. The server side is test/integration/capsules.spec.ts.
 */

test.use({ viewport: { width: 390, height: 844 } });

test('make a capsule, choose its garments, and toggle one from its page', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await signIn(page, 'capsules');
  for (const [name, category] of [
    ['Oxford', 'tops'],
    ['Chinos', 'bottoms'],
    ['Hoodie', 'tops'],
  ]) {
    const res = await page.request.post('/wardrobe', {
      form: { name, category, props: '1' },
      headers: SAME_ORIGIN,
    });
    expect(res.ok()).toBe(true);
  }

  await page.goto('/wardrobe');
  await page.getByRole('tab', { name: 'Capsules' }).click();
  await expect(page).toHaveURL(/\/capsules$/);
  await expect(page.getByText('No capsules yet')).toBeVisible();
  await page.getByRole('link', { name: 'Create your first capsule' }).click();
  await page.getByLabel('Name *').fill('Office');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'Office' })).toBeVisible();
  await expect(page.getByText('Capsule created')).toBeVisible();
  await expect(page).not.toHaveURL(/created/);

  await page.getByRole('link', { name: 'Choose garments' }).first().click();
  await expect(
    page.getByRole('heading', { name: 'Garments in Office' }),
  ).toBeVisible();
  await page.getByRole('checkbox', { name: 'Oxford' }).check();
  await page.getByRole('checkbox', { name: 'Chinos' }).check();
  await expect(page.locator('#selected-count')).toHaveText('2');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page).toHaveURL(/\/capsules\/\d+(\?|$)/);
  await expect(page.getByText('2 added · 0 removed')).toBeVisible();
  await expect(page.locator('#capsule-grid > a')).toHaveCount(2);

  // Back in the picker, the members start checked; unchecking one removes it.
  await page.getByRole('link', { name: 'Choose garments' }).click();
  await expect(page.getByRole('checkbox', { name: 'Oxford' })).toBeChecked();
  await expect(page.locator('#selected-count')).toHaveText('2');
  await page.getByRole('checkbox', { name: 'Chinos' }).uncheck();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('0 added · 1 removed')).toBeVisible();
  await expect(page.locator('#capsule-grid > a')).toHaveCount(1);

  // The garment page's toggle saves on tap and comes back checked.
  await page.locator('#capsule-grid > a').first().click();
  const toggle = page.getByRole('checkbox', { name: 'Office' });
  await expect(toggle).toBeChecked();
  const saved = page.waitForResponse(
    (res) =>
      res.url().endsWith('/capsules') && res.request().method() === 'POST',
  );
  await toggle.uncheck();
  expect((await saved).status()).toBe(200);
  await expect(
    page.getByRole('checkbox', { name: 'Office' }),
  ).not.toBeChecked();

  await page.goto('/capsules');
  await expect(page.getByText('0 garments').last()).toBeVisible();
  expect(errors).toEqual([]);
});
