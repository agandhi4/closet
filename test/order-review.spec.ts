import { expect, type Page, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Db } from '../src/db/client';
import { orderEmail, orderItem } from '../src/db/schema';
import { ORDER_REVIEW_OWNER, signInAs } from './support/e2e-session';
import { householdToday } from './support/household-today';
import { userIdOf, withServerDb } from './support/server-db';

/**
 * "From your orders" (#25) at phone width. The poll's own path (JMAP, the
 * trust check, the links) is the integration tier's
 * (test/integration/order-mail.spec.ts); here the review list's rows are
 * seeded straight into the server's database, as the poll would write them,
 * for ORDER_REVIEW_OWNER, the account playwright.config.ts names as the
 * order mail's owner. Their product links point at `.invalid` hosts, so
 * "Add to closet" meets a page that cannot be fetched and opens the form
 * with the stored details: no shop is needed.
 */

test.use({ viewport: { width: 390, height: 844 } });

/** Two pending items from one order email of the owner's, with unique links. */
async function seedOrder(ownerId: number): Promise<{ run: string }> {
  const run = randomUUID().slice(0, 8);
  await withServerDb((db) => insertOrder(db, ownerId, run));
  return { run };
}

async function insertOrder(db: Db, ownerId: number, run: string) {
  const [email] = await db
    .insert(orderEmail)
    .values({
      accountId: 'e2e',
      emailId: `e2e-${run}`,
      receivedAt: new Date(),
      outcome: 'imported',
      items: 2,
    })
    .returning({ id: orderEmail.id });
  await db.insert(orderItem).values(
    [
      {
        name: `Relaxed Linen Shirt ${run}`,
        brand: 'Northfield',
        price: '49.90',
      },
      { name: `Merino Crew Socks ${run}`, brand: null, price: '24.00' },
    ].map((item, i) => ({
      ...item,
      ownerId,
      orderEmailId: email.id,
      productUrl: `https://shop-${run}.invalid/products/item-${i}`,
      currency: 'USD',
      orderedOn: householdToday(),
    })),
  );
}

/**
 * Signs in as the order mail's owner; their id. Every test shares that one
 * account, so each asserts only on the items its own run seeded (names
 * carry the run): another test, a retry or an earlier run on the same
 * database may list items beside them.
 */
async function signInAsOwner(page: Page): Promise<number> {
  await signInAs(page, ORDER_REVIEW_OWNER);
  return withServerDb((db) => userIdOf(db, ORDER_REVIEW_OWNER));
}

test('the review list fits a phone, and dismissing takes an item off it', async ({
  page,
}) => {
  const { run } = await seedOrder(await signInAsOwner(page));

  await page.goto('/wardrobe');
  await page.locator('#wardrobe-menu > summary').click();
  await page.getByRole('link', { name: 'From your orders' }).click();
  await expect(page).toHaveURL(/\/wardrobe\/orders$/);

  const items = page.locator('#order-items > li').filter({ hasText: run });
  await expect(items).toHaveCount(2);
  const shirt = items.filter({ hasText: `Relaxed Linen Shirt ${run}` });
  await expect(shirt).toBeVisible();
  await expect(shirt.getByText('$49.90')).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  const socks = items.filter({ hasText: `Merino Crew Socks ${run}` });
  await socks.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page).toHaveURL(/\/wardrobe\/orders$/);
  await expect(items).toHaveCount(1);
  await expect(page.getByText(`Merino Crew Socks ${run}`)).toHaveCount(0);
});

test('"Add to closet" falls back to the order\'s details when the product page cannot be read', async ({
  page,
}) => {
  const { run } = await seedOrder(await signInAsOwner(page));
  await page.goto('/wardrobe/orders');

  const shirt = page
    .locator('#order-items > li')
    .filter({ hasText: `Relaxed Linen Shirt ${run}` });
  await shirt.getByRole('button', { name: 'Add to closet' }).click();

  await expect(page.locator('#garment-order-item')).toBeVisible();
  await expect(
    page.getByText("The product page couldn't be read just now"),
  ).toBeVisible();
  await expect(page.locator('input[name="name"]')).toHaveValue(
    `Relaxed Linen Shirt ${run}`,
  );
  await expect(page.locator('input[name="brand"]')).toHaveValue('Northfield');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  // Saving adds it to the closet and takes it off the list.
  await page.locator('input[name="category"]').fill('tops');
  await page.getByRole('button', { name: 'Save' }).click();
  // The garment page (its ?created=1 flag is dropped from the address once shown).
  await expect(page).toHaveURL(/\/wardrobe\/\d+$/);
  await page.goto('/wardrobe/orders');
  await expect(page.getByText(`Relaxed Linen Shirt ${run}`)).toHaveCount(0);
});
