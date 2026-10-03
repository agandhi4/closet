import { expect, type Page, test } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { planItem, planLook } from '../src/db/schema';
import { changeCandidates } from '../src/web/plans/candidates';
import { proposeLook } from '../src/web/plans/looks';
import { createGarment } from './support/e2e-data';
import { SAME_ORIGIN, signIn } from './support/e2e-session';
import { pageErrors } from './support/page-errors';
import { userIdOf, withServerDb } from './support/server-db';

/**
 * A look becomes an outfit at phone width (#292): Bought it on the look's
 * last piece to buy, the result page listing the look it completed, Save
 * as outfit, and the outfit's page. The rules (refusals, idempotency, the
 * link) are test/integration/look-outfits.spec.ts's.
 */

test.use({ viewport: { width: 390, height: 844 } });

async function post(page: Page, url: string, form: Record<string, string>) {
  const res = await page.request.post(url, { form, headers: SAME_ORIGIN });
  expect(res.ok()).toBe(true);
  return new URL(res.url()).pathname;
}

test('buy the last piece, Save as outfit, land on the outfit', async ({
  page,
}) => {
  const errors = pageErrors(page);
  const email = await signIn(page, 'look-to-outfit');
  const plan = await post(page, '/wardrobe/plans', { name: 'Autumn office' });
  const planId = Number(plan.split('/').pop());
  await post(page, `${plan}/items`, {
    name: 'Brown loafers',
    category: 'footwear',
    quantity: '1',
    priority: 'medium',
  });
  const loafers = await createGarment(page, 'Suede loafers', 'footwear', {
    to: 'wishlist',
    wishlist: '1',
    props: '1',
    product: '1',
  });
  const shirt = await createGarment(page, 'Oxford shirt', 'tops');
  const chinos = await createGarment(page, 'Chinos', 'bottoms');
  // What the agent did over MCP: the candidate and a look holding it.
  const lookId = await withServerDb(async (db) => {
    const ownerId = await userIdOf(db, email);
    const [{ id: itemId }] = await db
      .select({ id: planItem.id })
      .from(planItem)
      .where(eq(planItem.planId, planId));
    await changeCandidates(db, ownerId, {
      add: { itemIds: [itemId], garmentIds: [loafers] },
    });
    return (
      await proposeLook(
        db,
        ownerId,
        planId,
        { name: 'Office Tuesday', occasion: 'work', note: 'Sharp but easy' },
        [shirt, chinos, loafers],
      )
    ).id;
  });

  // The shopping list's tile says the candidate is in a look.
  await page.goto(`/wardrobe/shopping?plan=${planId}`);
  await expect(page.locator(`[data-in-looks="1"]`)).toHaveText('In 1 look');

  await page.goto(`/wardrobe/${loafers}/bought`);
  await page.getByRole('button', { name: 'Move to closet' }).click();
  await expect(page).toHaveURL(new RegExp(`/wardrobe/${loafers}`));
  const completed = page.locator('#completed-looks');
  await expect(completed).toBeVisible();
  await expect(completed.getByRole('heading')).toHaveText(
    'This completes a look',
  );
  await expect(completed).toContainText('Office Tuesday');
  await expect(completed).toContainText('From Autumn office');
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);

  await completed.getByRole('button', { name: 'Save as outfit' }).click();
  await expect(page).toHaveURL(/\/outfits\/\d+$/);
  await expect(page.locator('h1')).toHaveText('Office Tuesday');
  const outfitId = Number(new URL(page.url()).pathname.split('/').pop());
  const [look] = await withServerDb((db) =>
    db
      .select({ outfitId: planLook.outfitId })
      .from(planLook)
      .where(eq(planLook.id, lookId)),
  );
  expect(look.outfitId).toBe(outfitId);

  // The plan page links the outfit the look became.
  await page.goto(plan);
  await expect(
    page.locator(`#look-${lookId} [data-look-saved]`),
  ).toHaveAttribute('href', `/outfits/${outfitId}`);
  expect(errors).toEqual([]);
});
