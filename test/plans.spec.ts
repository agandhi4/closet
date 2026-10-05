import { expect, type Page, test } from '@playwright/test';
import { createGarment } from './support/e2e-data';
import { signIn } from './support/e2e-session';
import { pageErrors } from './support/page-errors';

/**
 * Wardrobe plans in a browser at phone width (#34, slice 34a): the
 * Wardrobe's Plans tab (#295; the dock stays on Wardrobe), a new plan from
 * its add sheet, an item added through the form's selects and chips, the
 * plan as cards in sections by role with the gaps first and why, the
 * plan's ⋯ menu duplicating it, and the style
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
  const errors = pageErrors(page);
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

  // The plans, unlinked since #333 (Muse's picks are the Wishlist's) but
  // still served until #337; still the Wardrobe section.
  await page.goto('/wardrobe');
  await expect(page.getByRole('tab', { name: 'Plans' })).toHaveCount(0);
  await page.goto('/wardrobe/plans');
  await expect(page.locator('.dock a[aria-current="page"]')).toHaveAttribute(
    'href',
    '/wardrobe',
  );
  await expect(page.getByText('No plans yet')).toBeVisible();
  await expectNoSidewaysScroll(page);

  // The add sheet's New plan (the empty list offers one too).
  await page.getByRole('button', { name: 'Add' }).click();
  await page
    .locator('#add-sheet')
    .getByRole('link', { name: 'New plan' })
    .click();
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
    await page.getByLabel('Category *').fill('tops');
    await page.getByLabel('Type').selectOption({ label: item.type });
    await page.getByRole('checkbox', { name: item.color, exact: true }).check();
    await page.getByLabel('How many').fill(item.quantity);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved')).toBeVisible();
  }

  // The plan (#295): a card per item under its role, the gaps first, each
  // with its status on its photo and saying why.
  const tops = page.locator('#plan-role-top');
  await expect(tops.getByRole('heading')).toHaveText('Tops · 2');
  const sweater = tops.locator('li', { hasText: 'grey Sweater' });
  await expect(sweater).toHaveAttribute('data-status', 'missing');
  await expect(sweater.locator('[data-status-chip]')).toHaveText('To buy');
  await expect(sweater).toContainText('Worn out, to replace: Grey merino');
  await expect(sweater).toContainText('No options yet');
  const tees = tops.locator('li', { hasText: 'white T-shirt' });
  await expect(tees).toHaveAttribute('data-status', 'partly');
  await expect(tees.locator('[data-status-chip]')).toHaveText('1 of 2');
  // What the card used to carry is in its sheet (#312).
  await tees.getByRole('button').first().click();
  await expect(tees.getByRole('link', { name: 'White tee' })).toBeVisible();
  await page.keyboard.press('Escape');
  expect(
    await sweater.evaluate(
      (el, other) =>
        el.compareDocumentPosition(document.querySelector(other)!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      `#${await tees.getAttribute('id')}`,
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
  await page.getByRole('link', { name: 'Edit your style profile' }).click();
  await expectNoSidewaysScroll(page);
  await page.getByRole('checkbox', { name: 'Smart casual' }).check();
  await page.getByRole('radio', { name: 'Mid' }).check();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Style profile saved')).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: 'Smart casual' }),
  ).toBeChecked();
  // The week's rhythm is the week template's (#16): read here, set on the
  // Profile.
  await page.getByRole('link', { name: 'Set your week' }).click();
  await expect(page).toHaveURL(/\/auth\/profile#week$/);
});
