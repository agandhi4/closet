import { expect, type Page, test } from '@playwright/test';
import { SAME_ORIGIN, signIn } from './support/e2e-session';
import { householdToday } from './support/household-today';

/**
 * Wears and washes in a browser at phone width (#7): the calendar's worn
 * pill swapping in place and logging the outfit's wears, the garment page's
 * Washed, Wore today and "Where it is" answering through htmx, multiples,
 * and the laundry page's Mark washed. The server side is
 * test/integration/wears.spec.ts.
 */

test.use({ viewport: { width: 390, height: 844 } });

/** A POST whose redirect names the new row; its id. */
async function created(
  page: Page,
  url: string,
  form: Record<string, string>,
  pattern: RegExp,
): Promise<number> {
  const res = await page.request.post(url, {
    form,
    headers: SAME_ORIGIN,
    maxRedirects: 0,
  });
  expect(res.status()).toBe(302);
  return Number(pattern.exec(res.headers().location ?? '')?.[1]);
}

test('mark an outfit worn, wash it, log a wear alone, and do the laundry', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await signIn(page, 'wears');
  const garment = (name: string, quantity: string) =>
    created(
      page,
      '/wardrobe',
      { name, category: 'tops', care: '1', quantity },
      /^\/wardrobe\/(\d+)\?/,
    );
  const oxford = await garment('Oxford', '1');
  const tees = await garment('White tees', '3');
  const outfit = await created(
    page,
    '/outfits',
    { name: 'Office', category: 'tops', garmentId: String(oxford) },
    /^\/outfits\/(\d+)$/,
  );
  const scheduled = await page.request.post('/calendar', {
    form: { date: householdToday(), outfitId: String(outfit) },
    headers: SAME_ORIGIN,
  });
  expect(scheduled.ok()).toBe(true);

  // The worn pill swaps in place.
  await page.goto('/calendar');
  await page.getByRole('button', { name: 'Worn?' }).click();
  await expect(page.getByRole('button', { name: '✓ Worn' })).toBeVisible();

  // The outfit's garment has the wear; Washed answers the section.
  await page.goto(`/wardrobe/${oxford}`);
  const wear = page.locator('#garment-wear');
  await expect(wear.getByText('Worn once')).toBeVisible();
  await expect(wear.getByText('Worn today (calendar)')).toBeVisible();
  await expect(wear.getByText('Needs a wash')).toBeVisible();
  await wear.getByRole('button', { name: 'Washed' }).click();
  await expect(wear.getByText('0 since washed')).toBeVisible();
  await expect(wear.getByText('Needs a wash')).toBeHidden();

  // One of three tees worn alone, then lent (the note appears).
  await page.goto(`/wardrobe/${tees}`);
  await expect(page.getByText('3 identical')).toBeVisible();
  await page.getByRole('button', { name: 'Wore today' }).click();
  await expect(page.getByText('1 of 3 need a wash')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Undo “Wore today”' }),
  ).toBeVisible();

  // The wardrobe prompts the laundry; Mark washed empties the hamper.
  await page.goto('/wardrobe');
  await expect(page.getByText('1 garments need a wash')).toBeVisible();
  await page.getByRole('link', { name: 'Laundry' }).click();
  await expect(
    page.getByRole('checkbox', { name: 'White tees' }),
  ).toBeChecked();
  await page.getByRole('button', { name: 'Mark washed' }).click();
  await expect(page.getByText('1 washed')).toBeVisible();
  await expect(page.getByText('Nothing needs a wash.')).toBeVisible();

  await page.goto(`/wardrobe/${tees}`);
  await page.getByRole('radio', { name: 'Lent' }).check();
  await expect(page.getByLabel('Where, or who has it')).toBeVisible();

  expect(errors).toEqual([]);
});

test('offline, the wear writes are really disabled, and come back as they were', async ({
  page,
  context,
}) => {
  await signIn(page, 'wears-offline');
  const tee = await created(
    page,
    '/wardrobe',
    { name: 'Offline tee', category: 'tops' },
    /^\/wardrobe\/(\d+)\?/,
  );
  await page.goto(`/wardrobe/${tee}`);
  const wore = page.getByRole('button', { name: 'Wore today' });
  await expect(wore).toBeEnabled();
  // A control disabled for its own reason must stay so after reconnecting.
  await page
    .locator('#garment-wear form')
    .first()
    .evaluate((form) => {
      const own = document.createElement('button');
      own.id = 'own-disabled';
      own.type = 'button';
      own.disabled = true;
      form.append(own);
    });

  await context.setOffline(true);
  await expect(page.locator('#connectivity-banner')).toBeVisible();
  await expect(wore).toBeDisabled();
  await expect(wore).toHaveAttribute('aria-disabled', 'true');
  // The keyboard cannot submit it either.
  await wore.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Not worn yet')).toBeVisible();

  await context.setOffline(false);
  await expect(wore).toBeEnabled();
  await expect(wore).not.toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('#own-disabled')).toBeDisabled();
  await wore.click();
  await expect(page.getByText('Worn once')).toBeVisible();
});
