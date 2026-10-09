import { expect, test } from '@playwright/test';
import { createGarment } from './support/e2e-data';
import { SAME_ORIGIN, signIn } from './support/e2e-session';
import { pageErrors } from './support/page-errors';

/**
 * The wishlist in a browser at phone width (#18): the Wardrobe's Wishlist
 * tab (the dock stays on Wardrobe), "Find a replacement" from a worn-out
 * garment into the wishlist's form, the item's card, and "Bought it"
 * moving it into the closet while archiving the old one only when asked;
 * and "Goes with my closet" on an item's page (#18b) at 390 px. The server
 * side is test/integration/wishlist.spec.ts and goes-with.spec.ts.
 */

test.use({ viewport: { width: 390, height: 844 } });

test('find a replacement, see it on the wishlist, and buy it', async ({
  page,
}) => {
  const errors = pageErrors(page);
  await signIn(page, 'wishlist');
  const old = await createGarment(page, 'Grey merino', 'tops', {
    props: '1',
  });
  const marked = await page.request.post(`/wardrobe/${old}/condition`, {
    form: { condition: 'replace_soon', conditionNote: 'Pilling' },
    headers: SAME_ORIGIN,
  });
  expect(marked.ok()).toBe(true);

  // An empty wishlist first: a tab of the Wardrobe, the dock on Wardrobe.
  await page.goto('/wardrobe');
  await page.getByRole('tab', { name: 'Wishlist' }).click();
  await expect(page).toHaveURL(/\/wardrobe\/wishlist$/);
  await expect(page.getByText('Nothing on the wishlist yet')).toBeVisible();
  await expect(page.locator('.dock a[aria-current="page"]')).toHaveAttribute(
    'href',
    '/wardrobe',
  );

  // "Find a replacement" on the worn-out garment: the wishlist's form,
  // prefilled from it, the old one chosen as what it replaces.
  await page.goto(`/wardrobe/${old}`);
  await page.getByRole('link', { name: 'Find a replacement' }).click();
  await expect(
    page.getByRole('heading', { name: 'Add to wishlist' }),
  ).toBeVisible();
  await expect(page.getByLabel('Replaces')).toHaveValue(String(old));
  await expect(page.getByLabel('Category *')).toHaveValue('tops');
  await page.getByLabel('Name', { exact: true }).fill('Charcoal merino');
  await page.getByLabel('Price', { exact: true }).fill('79');
  await page.getByLabel('Product link').fill('https://shop.example/charcoal');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(
    page.getByRole('heading', { name: 'Charcoal merino' }),
  ).toBeVisible();
  await expect(page.locator('main [data-mark="to-buy"]')).toBeVisible();

  // The card: price, product link, what it replaces, no sideways scroll.
  await page.goto('/wardrobe/wishlist');
  const card = page.locator('#wishlist li', { hasText: 'Charcoal merino' });
  await expect(card).toContainText('$79.00');
  await expect(card).toContainText('Replaces Grey merino');
  await expect(
    card.getByRole('link', { name: 'View product' }),
  ).toHaveAttribute('target', '_blank');
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);

  // Bought it: the old one is offered for the archive, unchecked.
  await card.getByRole('link', { name: 'Bought it' }).click();
  const archive = page.getByRole('checkbox', {
    name: /Also archive Grey merino/,
  });
  await expect(archive).not.toBeChecked();
  await expect(page.getByLabel('Price paid')).toHaveValue('79.00');
  await page.getByLabel('Price paid').fill('72');
  await archive.check();
  await page.getByRole('button', { name: 'Move to closet' }).click();
  await expect(page.getByText('In your closet now')).toBeVisible();
  await expect(page).not.toHaveURL(/bought=1/);

  // In the closet now; the old one archived; the wishlist empty again.
  await page.goto('/wardrobe');
  const grid = page.locator('#wardrobe-grid');
  await expect(
    grid.getByText('Charcoal merino', { exact: true }),
  ).toBeVisible();
  await expect(grid.getByText('Grey merino', { exact: true })).toHaveCount(0);
  await page.goto('/wardrobe/wishlist');
  await expect(page.getByText('Nothing on the wishlist yet')).toBeVisible();

  expect(errors).toEqual([]);
});

test('"Goes with my closet" on a wishlist item fits a phone', async ({
  page,
}) => {
  const errors = pageErrors(page);
  await signIn(page, 'goes-with');
  const plain = { props: '1', pattern: 'solid' };
  const closet: [string, string, string][] = [
    ['Raw jeans', 'bottoms', 'blue'],
    ['Khaki chinos', 'bottoms', 'beige'],
    ['White sneakers', 'footwear', 'white'],
    ['Brown boots', 'footwear', 'brown'],
    ['Grey tee', 'tops', 'grey'],
  ];
  for (const [name, category, color] of closet) {
    await createGarment(page, name, category, { ...plain, color });
  }
  const item = await createGarment(page, 'Another grey tee', 'tops', {
    ...plain,
    color: 'grey',
    to: 'wishlist',
    wishlist: '1',
    replaces: '',
  });

  await page.goto(`/wardrobe/${item}`);
  const section = page.locator('#goes-with');
  await expect(section).toContainText('Makes 4 outfits with your closet');
  // The twin it would be: same kind and colour.
  await expect(section.locator('[data-goes-with-duplicates]')).toContainText(
    'Grey tee',
  );
  // The best few swipe sideways inside the card; the page itself never does.
  const strip = section.locator('[data-goes-with-strip]');
  await expect(strip).toHaveCSS('scroll-snap-type', 'x mandatory');
  await expect(strip.locator('article')).toHaveCount(3);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  // Display only: nothing to tap but the garments it pairs with (and the
  // strip's own step buttons, shown to a mouse).
  await expect(
    section.locator('button:not([data-snap-step]), form'),
  ).toHaveCount(0);
  await section.getByRole('link', { name: 'Khaki chinos' }).click();
  await expect(
    page.getByRole('heading', { name: 'Khaki chinos' }),
  ).toBeVisible();

  expect(errors).toEqual([]);
});
