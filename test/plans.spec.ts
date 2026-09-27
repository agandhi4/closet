import { expect, type Page, test } from '@playwright/test';
import { createGarment } from './support/e2e-data';
import { signIn } from './support/e2e-session';

/**
 * Wardrobe plans in a browser at phone width (#34, slice 34a): Plans from
 * the Wardrobe's ⋯ menu (the dock stays on Wardrobe), a new plan, an item
 * added through the form's selects and chips, the gap view grouped with
 * the gaps first and why, the plan's ⋯ menu duplicating it, and the style
 * profile. Nothing scrolls sideways at 390 px. The server side is
 * test/integration/plans.spec.ts.
 */

test.use({ viewport: { width: 390, height: 844 } });

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
}

test('plan the wardrobe, see its gaps, duplicate it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await signIn(page, 'plans');
  await createGarment(page, 'White tee', 'tops', {
    props: '1',
    type: 't-shirt',
    color: 'white',
  });
  await createGarment(page, 'Grey merino', 'tops', {
    props: '1',
    type: 'sweater',
    color: 'grey',
    care: '1',
    condition: 'replace_soon',
  });

  // Plans from the Wardrobe's ⋯ menu; still the Wardrobe section.
  await page.goto('/wardrobe');
  // <summary> has no button role in the accessibility tree: by its label.
  await page.getByLabel('More', { exact: true }).click();
  await page
    .locator('#wardrobe-menu')
    .getByRole('link', { name: 'Plans' })
    .click();
  await expect(page).toHaveURL(/\/wardrobe\/plans$/);
  await expect(page.locator('.dock a[aria-current="page"]')).toHaveAttribute(
    'href',
    '/wardrobe',
  );
  await expect(page.getByText('No plans yet')).toBeVisible();
  await expectNoSidewaysScroll(page);

  await page.getByRole('link', { name: '+ New plan' }).first().click();
  await page.getByLabel('Name *').fill('NYC minimal');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(
    page.getByRole('heading', { name: 'NYC minimal' }),
  ).toBeVisible();
  await expect(page.locator('#plan-tally')).toContainText('Active');

  // Two items through the form: a grey merino (the closet's is worn out)
  // and white tees ×2 (one owned).
  for (const item of [
    { type: 'Sweater', color: 'grey', quantity: '1' },
    { type: 'T-shirt', color: 'white', quantity: '2' },
  ]) {
    await page.getByRole('link', { name: '+ Add item' }).click();
    await expectNoSidewaysScroll(page);
    await page.getByLabel('Category *').selectOption('tops');
    await page.getByLabel('Type').selectOption({ label: item.type });
    await page.getByRole('checkbox', { name: item.color, exact: true }).check();
    await page.getByLabel('How many').fill(item.quantity);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved')).toBeVisible();
  }

  // The gap view: the gaps first, each saying why.
  const missing = page.locator('#plan-missing');
  await expect(missing).toContainText('grey Sweater');
  await expect(missing).toContainText('Worn out, to replace: Grey merino');
  const partly = page.locator('#plan-partly');
  await expect(partly).toContainText('white T-shirt');
  await expect(partly).toContainText('1 of 2');
  await expect(partly.getByRole('link', { name: 'White tee' })).toBeVisible();
  expect(
    await missing.evaluate(
      (el, other) =>
        el.compareDocumentPosition(document.querySelector(other)!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      '#plan-partly',
    ),
  ).toBeTruthy();
  await expectNoSidewaysScroll(page);

  // Duplicate from the plan's ⋯ menu: a copy to iterate on.
  await page.getByLabel('Plan actions').click();
  await page.getByRole('button', { name: 'Duplicate' }).click();
  await expect(
    page.getByRole('heading', { name: 'NYC minimal (copy)' }),
  ).toBeVisible();
  await expect(page.locator('#plan-tally')).not.toContainText('Active');
  await page.goto('/wardrobe/plans');
  await expect(page.locator('#plans li')).toHaveCount(2);
  await expect(page.locator('#plans li').first()).toContainText('Active');
  expect(errors).toEqual([]);
});

test('the style profile saves from the Profile', async ({ page }) => {
  await signIn(page, 'style');
  await page.goto('/auth/profile');
  await page.getByRole('link', { name: 'Style profile' }).click();
  await expectNoSidewaysScroll(page);
  await page.getByRole('checkbox', { name: 'Smart casual' }).check();
  await page.getByRole('radio', { name: 'Mid' }).check();
  await page.getByLabel('Work', { exact: true }).fill('3');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Style profile saved')).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: 'Smart casual' }),
  ).toBeChecked();
  await expect(page.getByLabel('Work', { exact: true })).toHaveValue('3');
});
