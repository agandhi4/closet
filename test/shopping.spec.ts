import { expect, type Page, test } from '@playwright/test';
import { createGarment } from './support/e2e-data';
import { SAME_ORIGIN, signIn } from './support/e2e-session';
import { pageErrors } from './support/page-errors';

/**
 * The shopping loop in a browser at phone width (#34, slice 34b): a plan's
 * gap gets a candidate from the wishlist on its candidates page, the
 * shopping list (from the Wardrobe's ⋯ menu, the dock on Wardrobe) shows it
 * against the budget with the totals, "Bought it" says it fulfils the item
 * and the list drops it; comparing a duplicate. Nothing scrolls sideways at
 * 390 px. The server side is test/integration/shopping.spec.ts.
 */

test.use({ viewport: { width: 390, height: 844 } });

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
}

async function post(page: Page, url: string, form: Record<string, string>) {
  const res = await page.request.post(url, { form, headers: SAME_ORIGIN });
  expect(res.ok()).toBe(true);
  return new URL(res.url()).pathname;
}

test('shop for a plan’s gap on the phone, buy the candidate', async ({
  page,
}) => {
  const errors = pageErrors(page);
  await signIn(page, 'shopping');
  const plan = await post(page, '/wardrobe/plans', { name: 'NYC minimal' });
  const items: Record<string, string>[] = [
    {
      name: 'Grey merino crewneck',
      category: 'tops',
      type: 'sweater',
      colors: 'grey',
      priority: 'high',
      budget: '50',
    },
    { name: 'Oxford shirt', category: 'tops', type: 'shirt', quantity: '3' },
  ];
  for (const item of items) {
    await post(page, `${plan}/items`, {
      quantity: '1',
      priority: 'medium',
      ...item,
    });
  }
  const wishlist = {
    to: 'wishlist',
    wishlist: '1',
    props: '1',
    product: '1',
    type: 'sweater',
    color: 'grey',
  };
  await createGarment(page, 'Uniqlo merino crew with a long name', 'tops', {
    ...wishlist,
    price: '49.90',
    sourceUrl: 'https://shop.example/merino',
  });
  await createGarment(page, 'Cashmere crew', 'tops', {
    ...wishlist,
    price: '120',
  });

  // The gap's candidates page: tick both wishlist items.
  await page.goto(plan);
  const merinoCard = page.locator('li[id^="plan-item-"]', {
    hasText: 'Grey merino crewneck',
  });
  await expect(merinoCard).toHaveAttribute('data-status', 'missing');
  await merinoCard.getByRole('link', { name: '+ Add a product' }).click();
  await expectNoSidewaysScroll(page);
  const choices = page.locator('#candidate-choices').getByRole('checkbox');
  await choices.first().check();
  await choices.nth(1).check();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved')).toBeVisible();
  // Its options (#295): a thumb each, named, and how many.
  await expect(
    merinoCard.getByRole('link', {
      name: 'Uniqlo merino crew with a long name',
    }),
  ).toBeVisible();
  await expect(merinoCard).toContainText('2 options');

  // The shopping list from the Wardrobe's ⋯ menu; still the Wardrobe section.
  await page.goto('/wardrobe');
  await page.getByLabel('More', { exact: true }).click();
  await page
    .locator('#wardrobe-menu')
    .getByRole('link', { name: 'Shopping list' })
    .click();
  await expect(page).toHaveURL(/\/wardrobe\/shopping$/);
  await expect(page.locator('.dock a[aria-current="page"]')).toHaveAttribute(
    'href',
    '/wardrobe',
  );
  await expect(page.locator('#shopping-summary')).toContainText(
    '2 items to find · 4 pieces',
  );
  await expect(page.locator('#shopping-summary')).toContainText(
    'Candidates from $49.90',
  );
  const merino = page.locator('#shopping-list > li').first();
  await expect(merino).toContainText('Grey merino crewneck');
  await expect(merino.locator('[data-budget="within"]')).toContainText(
    'Within budget',
  );
  await expect(merino.locator('[data-budget="over"]')).toContainText(
    'Over budget',
  );
  await expect(
    merino.getByRole('link', { name: 'View product' }),
  ).toHaveAttribute('target', '_blank');
  // "Goes with my closet"'s count (#18b) arrives in each candidate as it
  // comes into view: nothing in this empty closet yet.
  await expect(merino.locator('[data-outfit-count-slot]')).toHaveCount(0);
  await expect(merino.locator('[data-goes-with-count]')).toHaveText([
    'Goes with nothing in your closet yet',
    'Goes with nothing in your closet yet',
  ]);
  await expectNoSidewaysScroll(page);

  // The item is a strip (#272): the first candidate centred, its details
  // and "Bought it" under it alone; the neighbour's are out of reach until a
  // swipe (a tap on the peeking tile) centres it.
  const tiles = merino.locator('[data-snap-item]');
  await expect(tiles).toHaveCount(2);
  await expect(tiles.first()).toHaveAttribute('data-selected', '');
  // The links are reachable by role: the tile is not an `option`.
  await expect(
    tiles.first().getByRole('link', { name: 'Bought it' }),
  ).toBeVisible();
  await expect(merino.getByRole('link', { name: 'Bought it' })).toHaveCount(1);
  await expect(
    tiles.nth(1).getByRole('link', { name: 'Bought it' }),
  ).toBeHidden();
  await tiles.nth(1).getByRole('link', { name: 'Cashmere crew' }).click();
  await expect(tiles.nth(1)).toHaveAttribute('data-selected', '');
  await expect(page).toHaveURL(/\/wardrobe\/shopping$/);
  await expect(
    tiles.nth(1).getByRole('link', { name: 'Bought it' }),
  ).toBeVisible();
  await tiles
    .first()
    .getByRole('link', { name: /Uniqlo merino/ })
    .click();
  await expect(tiles.first()).toHaveAttribute('data-selected', '');
  await expectNoSidewaysScroll(page);

  // Bought it: it fulfils the item; the other candidate is offered, ticked.
  await tiles.first().getByRole('link', { name: 'Bought it' }).click();
  await expect(page.locator('#bought-plans')).toContainText(
    'It fulfils this item.',
  );
  await expect(
    page.getByRole('checkbox', { name: 'Remove Cashmere crew' }),
  ).toBeChecked();
  await expectNoSidewaysScroll(page);
  await page.getByRole('button', { name: 'Move to closet' }).click();
  await expect(page.getByText('In your closet now')).toBeVisible();

  await page.goto('/wardrobe/shopping');
  await expect(page.locator('#shopping-list > li')).toHaveCount(1);
  await expect(page.locator('#shopping-list')).toContainText('Oxford shirt');
  await expect(page.locator('#shopping-list')).not.toContainText(
    'Cashmere crew',
  );

  // Compare with a duplicate from the plan's ⋯ menu.
  await post(page, `${plan}/duplicate`, {});
  await page.goto(plan);
  await page.getByLabel('Plan actions').click();
  await page.getByRole('link', { name: 'Compare with another plan' }).click();
  await expect(page.locator('#compare-same')).toContainText(
    'In both, the same · 2',
  );
  await expectNoSidewaysScroll(page);
  expect(errors).toEqual([]);
});
