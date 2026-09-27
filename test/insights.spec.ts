import { expect, type Page, test } from '@playwright/test';
import { createGarment } from './support/e2e-data';
import { SAME_ORIGIN, signIn } from './support/e2e-session';

/**
 * Insights in a browser at phone width (#17): opened from the Wardrobe's
 * ⋯ menu (the dock stays on Wardrobe), every card laid out in one column
 * without sideways scrolling, the unworn window's chips, "Style this". The
 * figures themselves are test/integration/insights.spec.ts's.
 */

test.use({ viewport: { width: 390, height: 844 } });

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
}

test('insights on the phone, from the Wardrobe’s ⋯ menu', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await signIn(page, 'insights');
  const product = { product: '1', care: '1', washAfterWears: '' };
  const tee = await createGarment(page, 'White tee', 'tops', {
    ...product,
    brand: 'Uniqlo',
    color: 'white',
    price: '24.90',
    quantity: '3',
  });
  await createGarment(
    page,
    'A jacket with a rather long name to wrap',
    'outerwear',
    {
      ...product,
      brand: 'Barbour',
      color: 'green',
      price: '300',
      quantity: '1',
      condition: 'needs_repair',
    },
  );
  const wore = await page.request.post(`/wardrobe/${tee}/wear`, {
    form: { worn: '1' },
    headers: SAME_ORIGIN,
  });
  expect(wore.ok()).toBe(true);

  await page.goto('/wardrobe');
  await page.getByLabel('More', { exact: true }).click();
  await page
    .locator('#wardrobe-menu')
    .getByRole('link', { name: 'Insights' })
    .click();
  await expect(page).toHaveURL(/\/wardrobe\/insights$/);
  await expect(page.locator('.dock a[aria-current="page"]')).toHaveAttribute(
    'href',
    '/wardrobe',
  );
  await expect(page.locator('#insights-worn')).toContainText('50%');
  await expect(page.locator('#insights-attention')).toContainText(
    'Needs repair: 1',
  );
  // Three tees at $24.90 each: the cost is price × copies (CLAUDE.md, Insights).
  await expect(page.locator('#insights-cost')).toContainText(
    '$74.70 a wear · worn once',
  );
  await expect(page.locator('[data-strip="closet"] [data-colour]')).toHaveCount(
    2,
  );
  await expectNoSidewaysScroll(page);

  // The unworn window: a chip link, the page again at its card.
  await page
    .locator('#insights-unworn')
    .getByRole('link', { name: '30 days' })
    .click();
  await expect(page).toHaveURL(/unworn=30/);
  const unworn = page.locator('#insights-unworn');
  await expect(unworn).toContainText('A jacket with a rather long name');
  await unworn.getByRole('link', { name: 'Style this' }).click();
  await expect(page).toHaveURL(/\/outfits\/ideas\?with=\d+$/);
  await expect(page.getByText('With A jacket')).toBeVisible();
  expect(errors).toEqual([]);
});
