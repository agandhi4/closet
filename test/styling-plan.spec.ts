import { expect, type Page, test } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { planItem } from '../src/db/schema';
import { createGarment } from './support/e2e-data';
import { SAME_ORIGIN, signIn } from './support/e2e-session';
import { pageErrors } from './support/page-errors';
import { withServerDb } from './support/server-db';

/**
 * Styling with a plan's candidates in a browser at phone width (#273):
 * from the plan review's "Style with my closet", a pair of boots to buy
 * waits on a strip of its own beside the closet's tee, badged "To buy"; a
 * swipe chooses it, and Save is refused naming it, with a link to "Bought
 * it". The rules are test/integration/styling-plan.spec.ts's.
 */

test.use({ viewport: { width: 390, height: 844 } });

async function post(page: Page, url: string, form: Record<string, string>) {
  const res = await page.request.post(url, { form, headers: SAME_ORIGIN });
  expect(res.ok()).toBe(true);
  return new URL(res.url()).pathname;
}

test('style a candidate with the closet from the review: badge, swipe, refused save', async ({
  page,
}) => {
  const errors = pageErrors(page);
  await signIn(page, 'styling-plan');
  const tee = await createGarment(page, 'Blue tee', 'tops');
  const plan = await post(page, '/wardrobe/plans', { name: 'Muse’s draft' });
  await post(page, `${plan}/items`, {
    quantity: '1',
    priority: 'medium',
    name: 'Black boots',
    category: 'footwear',
  });
  const boots = await createGarment(page, 'Chelsea boots', 'footwear', {
    to: 'wishlist',
    wishlist: '1',
    props: '1',
    product: '1',
  });
  // What the agent did over MCP: proposed the item.
  const planId = Number(plan.split('/').pop());
  const [item] = await withServerDb((db) =>
    db
      .update(planItem)
      .set({ proposed: true })
      .where(eq(planItem.planId, planId))
      .returning({ id: planItem.id }),
  );
  await post(page, `${plan}/items/${item.id}/candidates`, {
    garmentIds: String(boots),
  });

  await page.goto(`${plan}/review`);
  await page.locator('[data-style-with-closet]').click();
  await expect(page).toHaveURL(`/styling?plan=${planId}`);
  await expect(page.locator('[data-styling-plan]')).toBeVisible();

  // The closet has no shoes: the row exists for the candidate, opened on
  // "No garment", with the badge on the piece.
  const footwear = page.locator('[data-styling-row="footwear"]');
  const strip = footwear.locator('[data-snap-strip]');
  await expect(footwear.locator('input[name="garmentId"]')).toHaveValue('');
  await expect(
    strip.locator(`[data-snap-value="${boots}"] [data-to-buy]`),
  ).toHaveText('To buy');
  await expect(
    page.locator(`[data-styling-row="top"] [data-snap-value="${tee}"]`),
  ).toBeVisible();
  await expect(page.locator('[data-to-buy]')).toHaveCount(1);

  // A swipe is the strip's own scrolling: one wheel step centres the boots.
  await strip.scrollIntoViewIfNeeded();
  const box = (await strip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(box.width / 3, 0);
  await expect(footwear.locator('input[name="garmentId"]')).toHaveValue(
    String(boots),
  );

  // Save names the piece, links to its "Bought it", and stores nothing.
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('[data-styling-save]').click();
  const refused = page.locator('[data-styling-refused]');
  await expect(refused).toContainText(
    'Chelsea boots is on your wishlist, not bought yet',
  );
  await expect(
    refused.getByRole('link', { name: 'Bought it: Chelsea boots' }),
  ).toHaveAttribute('href', `/wardrobe/${boots}/bought`);
  await expect(page.locator('[data-styling-plan]')).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  expect(errors).toEqual([]);
});
