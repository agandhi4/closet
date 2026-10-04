import { expect, type Page, test } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { planItem } from '../src/db/schema';
import { changeCandidates } from '../src/web/plans/candidates';
import { proposeLook, reactToLooks } from '../src/web/plans/looks';
import { createGarment } from './support/e2e-data';
import { SAME_ORIGIN, signIn } from './support/e2e-session';
import { pageErrors } from './support/page-errors';
import { userIdOf, withServerDb } from './support/server-db';

/**
 * The Outfits tab's "From your plan" row at phone width (#302): the active
 * plan's looks above the saved outfits, loved first, To buy on the tile and
 * Save as outfit on a complete look. The rules (declined, owner-only, byte
 * stability, statements) are test/integration/outfits-plan-row.spec.ts's.
 */

test.use({ viewport: { width: 390, height: 844 } });

async function post(page: Page, url: string, form: Record<string, string>) {
  const res = await page.request.post(url, { form, headers: SAME_ORIGIN });
  expect(res.ok()).toBe(true);
  return new URL(res.url()).pathname;
}

test('the row shows the plan’s looks; Save as outfit lands on the outfit', async ({
  page,
}) => {
  const errors = pageErrors(page);
  const email = await signIn(page, 'outfits-plan-row');
  const plan = await post(page, '/wardrobe/plans', { name: 'Autumn office' });
  const planId = Number(plan.split('/').pop());
  await post(page, `${plan}/items`, {
    name: 'Brown loafers',
    category: 'footwear',
    quantity: '1',
    priority: 'medium',
  });
  const wishlisted = await createGarment(page, 'Suede loafers', 'footwear', {
    to: 'wishlist',
    wishlist: '1',
    props: '1',
    product: '1',
  });
  const boots = await createGarment(page, 'Chelsea boots', 'footwear');
  const shirt = await createGarment(page, 'Oxford shirt', 'tops');
  const tee = await createGarment(page, 'Grey tee', 'tops');
  const chinos = await createGarment(page, 'Chinos', 'bottoms');
  await withServerDb(async (db) => {
    const ownerId = await userIdOf(db, email);
    const [{ id: itemId }] = await db
      .select({ id: planItem.id })
      .from(planItem)
      .where(eq(planItem.planId, planId));
    await changeCandidates(db, ownerId, {
      add: { itemIds: [itemId], garmentIds: [wishlisted] },
    });
    await proposeLook(
      db,
      ownerId,
      planId,
      { name: 'Office Tuesday', occasion: 'work', note: 'Sharp but easy' },
      [shirt, chinos, wishlisted],
    );
    const ready = await proposeLook(
      db,
      ownerId,
      planId,
      { name: 'Easy Friday', occasion: 'work', note: 'Nothing to buy' },
      [tee, chinos, boots],
    );
    await reactToLooks(db, ownerId, planId, 'love', [{ lookId: ready.id }]);
  });

  await page.goto('/outfits');
  const row = page.locator('#plan-looks');
  await expect(row.getByRole('heading', { level: 2 })).toContainText(
    'From your plan',
  );
  // Loved first; the look still to buy says so and offers no save.
  await expect(row.locator('h3')).toHaveText(['Easy Friday', 'Office Tuesday']);
  await expect(row.getByText('1 to buy')).toBeVisible();
  await expect(row.getByRole('button', { name: 'Save as outfit' })).toHaveCount(
    1,
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'test-results/302a-outfits-390.png' });

  await row.getByRole('button', { name: 'Save as outfit' }).click();
  await expect(page).toHaveURL(/\/outfits\/\d+$/);
  await expect(page.locator('h1')).toHaveText('Easy Friday');
  expect(errors).toEqual([]);
});
