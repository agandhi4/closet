import { expect, type Page, test } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { planItem } from '../src/db/schema';
import { createGarment } from './support/e2e-data';
import { SAME_ORIGIN, signIn } from './support/e2e-session';
import { pageErrors } from './support/page-errors';
import { withServerDb } from './support/server-db';

/**
 * The plan review in a browser at phone width (#271): an agent's proposals
 * as strips, a swipe to another candidate, "Accept these", and the gap view
 * with the choices made (the pick kept, the unpicked candidate gone from
 * the wishlist). The rules and the data-safety cases are
 * test/integration/plan-review.spec.ts's.
 */

test.use({ viewport: { width: 390, height: 844 } });

async function post(page: Page, url: string, form: Record<string, string>) {
  const res = await page.request.post(url, { form, headers: SAME_ORIGIN });
  expect(res.ok()).toBe(true);
  return new URL(res.url()).pathname;
}

test('review an agent’s proposals as strips, swipe to a candidate, accept', async ({
  page,
}) => {
  const errors = pageErrors(page);
  await signIn(page, 'plan-review');
  const plan = await post(page, '/wardrobe/plans', { name: 'Muse’s draft' });
  const items: Record<string, string>[] = [
    {
      name: 'Black boots',
      category: 'footwear',
      colors: 'black',
      budget: '200',
    },
    { name: 'Camel coat', category: 'outerwear' },
  ];
  for (const item of items) {
    await post(page, `${plan}/items`, {
      quantity: '1',
      priority: 'medium',
      ...item,
    });
  }
  const wishlist = { to: 'wishlist', wishlist: '1', props: '1', product: '1' };
  const cheap = await createGarment(page, 'Cheap black boots', 'footwear', {
    ...wishlist,
    color: 'black',
    price: '150',
  });
  const navy = await createGarment(page, 'Navy boots', 'footwear', {
    ...wishlist,
    color: 'blue',
    price: '180',
  });
  // What the agent did over MCP: proposed both items (propose_plan_item).
  const planId = Number(plan.split('/').pop());
  const [boots, coat] = await withServerDb(async (db) => {
    const rows = await db
      .update(planItem)
      .set({ proposed: true })
      .where(eq(planItem.planId, planId))
      .returning({ id: planItem.id, name: planItem.name });
    const id = (name: string) => rows.find((row) => row.name === name)!.id;
    return [id('Black boots'), id('Camel coat')];
  });
  for (const garmentId of [cheap, navy]) {
    await post(page, `${plan}/items/${boots}/candidates`, {
      garmentIds: String(garmentId),
    });
  }

  await page.goto(plan);
  await page.locator('#plan-review').click();
  await expect(page).toHaveURL(`${plan}/review`);
  await expect(page.locator('h1')).toHaveText('Review Muse’s draft');
  // Top to toe: the coat (a layer) before the boots.
  await expect(page.locator('section[id^="review-item-"]')).toHaveCount(2);
  await expect(page.locator('section[id^="review-item-"]').first()).toHaveId(
    `review-item-${coat}`,
  );
  const coatPick = page.locator(`#review-item-${coat} input[name="pick"]`);
  const bootsStrip = page.locator(`#review-item-${boots} [data-snap-strip]`);
  const bootsPick = page.locator(`#review-item-${boots} input[name="pick"]`);
  await expect(coatPick).toHaveValue(`${coat}:keep`);
  // The matching candidate within budget is first, and where the strip starts.
  await expect(bootsPick).toHaveValue(`${boots}:${cheap}`);
  await expect(
    bootsStrip.locator(`[data-snap-value="${boots}:${cheap}"]`),
  ).toContainText('Within budget');

  // A swipe is the strip's own scrolling: wheel it one item on, and the
  // navy pair (it doesn't match) is centred and chosen.
  await bootsStrip.scrollIntoViewIfNeeded();
  const box = (await bootsStrip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(box.width / 3, 0);
  await expect(bootsPick).toHaveValue(`${boots}:${navy}`);
  const navyTile = bootsStrip.locator(`[data-snap-value="${boots}:${navy}"]`);
  await expect(navyTile).toHaveAttribute('data-selected', '');
  await expect(
    navyTile.getByText('Doesn’t match the item: blue vs black'),
  ).toBeVisible();
  // The centred tile's outfit count loads once seen in the strip.
  await expect(navyTile.locator('[data-goes-with-count]')).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);

  // The removal is opted into: the box starts unticked.
  const removeUnpicked = page.getByLabel(
    'Remove the products I didn’t pick from my wishlist',
  );
  await expect(removeUnpicked).not.toBeChecked();
  await removeUnpicked.check();
  await page.getByRole('button', { name: 'Accept these' }).click();

  await expect(page).toHaveURL(plan);
  await expect(page.locator('#plan-toast')).toContainText(
    'Review saved. 1 product removed from your wishlist',
  );
  await expect(page.locator('#plan-review')).toHaveCount(0);
  const bootsCard = page.locator(`#plan-item-${boots}`);
  await expect(bootsCard).toHaveAttribute('data-status', 'missing');
  await expect(bootsCard.locator('[data-candidates]')).toContainText(
    'Navy boots',
  );
  await expect(bootsCard.locator('[data-candidates]')).not.toContainText(
    'Cheap black boots',
  );
  await expect(page.locator(`#plan-item-${coat}`)).toHaveAttribute(
    'data-status',
    'missing',
  );
  // The unpicked candidate stood for nothing else: off the wishlist.
  const gone = await page.request.get(`/wardrobe/${cheap}`);
  expect(gone.status()).toBe(404);
  expect(errors).toEqual([]);
});
