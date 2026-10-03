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
 * A plan's looks in a browser at phone width (#291): the review's Looks
 * strip, a swipe from look to look, Love it on one and Change this… with a
 * note on another, "Accept these", and the plan page with the loved look
 * leading its strip and the changed one listed apart with the note. The
 * rules and the data-safety cases are
 * test/integration/plan-look-reactions.spec.ts's.
 */

test.use({ viewport: { width: 390, height: 844 } });

async function post(page: Page, url: string, form: Record<string, string>) {
  const res = await page.request.post(url, { form, headers: SAME_ORIGIN });
  expect(res.ok()).toBe(true);
  return new URL(res.url()).pathname;
}

test('swipe the looks, Love one, Change another with a note, Accept, see them grouped', async ({
  page,
}) => {
  const errors = pageErrors(page);
  const email = await signIn(page, 'plan-looks');
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
  const knit = await createGarment(page, 'Merino knit', 'tops');
  // What the agent did over MCP: linked the candidate and proposed two
  // looks (propose_look), through the app's own writers.
  const [first, second] = await withServerDb(async (db) => {
    const ownerId = await userIdOf(db, email);
    const [{ id: itemId }] = await db
      .select({ id: planItem.id })
      .from(planItem)
      .where(eq(planItem.planId, planId));
    await changeCandidates(db, ownerId, {
      add: { itemIds: [itemId], garmentIds: [loafers] },
    });
    const look = async (name: string, garmentIds: number[]) =>
      (
        await proposeLook(
          db,
          ownerId,
          planId,
          { name, occasion: 'work', note: `${name}: sharp but easy` },
          garmentIds,
        )
      ).id;
    return [
      await look('Office Tuesday', [shirt, chinos, loafers]),
      await look('Friday knit', [knit, chinos, loafers]),
    ];
  });

  await page.goto(`${plan}/review`);
  const strip = page.locator('#review-looks [data-snap-strip]');
  const firstTile = page.locator(`#review-look-${first}`);
  const secondTile = page.locator(`#review-look-${second}`);
  await expect(firstTile).toHaveAttribute('data-selected', '');
  // Each look shows its piece to buy.
  await expect(firstTile.locator('[data-to-buy]')).toHaveText('To buy');
  await expect(firstTile.getByText('Work · 1 to buy')).toBeVisible();
  // The tiles are the same height.
  const [a, b] = await Promise.all([
    firstTile.boundingBox(),
    secondTile.boundingBox(),
  ]);
  expect(a!.height).toBe(b!.height);

  await firstTile.getByRole('radio', { name: 'Love it' }).check();

  // A swipe is the strip's own scrolling: wheel it one look on.
  await strip.scrollIntoViewIfNeeded();
  const box = (await strip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(box.width / 2, 0);
  await expect(secondTile).toHaveAttribute('data-selected', '');
  // The first tile's controls are out of reach now; the second's are not.
  await expect(
    firstTile.getByRole('radio', { name: 'Love it' }),
  ).not.toBeVisible();
  await secondTile.getByRole('radio', { name: 'Change this…' }).check();
  await secondTile
    .getByRole('textbox', { name: 'Note for your agent about Friday knit' })
    .fill('A navy knit instead');
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);

  await page.getByRole('button', { name: 'Accept these' }).click();
  await expect(page).toHaveURL(plan);
  await expect(page.locator('#plan-toast')).toContainText('Review saved');

  // The plan page: the loved look leads the strip; the changed one waits
  // on the agent, apart, with the note.
  await expect(page.locator(`#look-${first}`)).toHaveAttribute(
    'data-reaction',
    'loved',
  );
  await expect(page.locator(`#look-${first} [data-reaction-chip]`)).toHaveText(
    'Loved',
  );
  const waiting = page.locator('#plan-looks-revise');
  await expect(waiting.locator(`#look-${second}`)).toBeVisible();
  await expect(waiting).toContainText('Your note: A navy knit instead');
  const rows = await withServerDb((db) =>
    db
      .select({ id: planLook.id, reaction: planLook.reaction })
      .from(planLook)
      .where(eq(planLook.planId, planId)),
  );
  expect(new Map(rows.map((row) => [row.id, row.reaction]))).toEqual(
    new Map([
      [first, 'loved'],
      [second, 'revise'],
    ]),
  );
  expect(errors).toEqual([]);
});

test('a fresh plan page: swipe to the second look and Love it', async ({
  page,
}) => {
  const errors = pageErrors(page);
  const email = await signIn(page, 'plan-looks-fresh');
  const plan = await post(page, '/wardrobe/plans', { name: 'Winter' });
  const planId = Number(plan.split('/').pop());
  const shirt = await createGarment(page, 'Oxford shirt', 'tops');
  const chinos = await createGarment(page, 'Chinos', 'bottoms');
  const knit = await createGarment(page, 'Merino knit', 'tops');
  const [first, second] = await withServerDb(async (db) => {
    const ownerId = await userIdOf(db, email);
    const look = async (name: string, garmentIds: number[]) =>
      (
        await proposeLook(
          db,
          ownerId,
          planId,
          { name, occasion: null, note: null },
          garmentIds,
        )
      ).id;
    return [
      await look('Office Tuesday', [shirt, chinos]),
      await look('Friday knit', [knit, chinos]),
    ];
  });

  // The document's first page: nothing has loaded the strip's module yet.
  await page.goto(plan);
  const strip = page.locator('#plan-looks [data-snap-strip]');
  const secondTile = page.locator(`#look-${second}`);
  await expect(page.locator(`#look-${first}`)).toHaveAttribute(
    'data-selected',
    '',
  );
  await strip.scrollIntoViewIfNeeded();
  const box = (await strip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(box.width / 2, 0);
  await expect(secondTile).toHaveAttribute('data-selected', '');
  await secondTile.getByRole('button', { name: 'Love it' }).click();
  await expect(page.locator(`#look-${second}`)).toHaveAttribute(
    'data-reaction',
    'loved',
  );
  expect(errors).toEqual([]);
});
