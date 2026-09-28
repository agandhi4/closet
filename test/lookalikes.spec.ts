import { expect, type Page, test } from '@playwright/test';
import { createGarment } from './support/e2e-data';
import { signIn } from './support/e2e-session';

/**
 * The duplicate check at phone width (#20): what only a browser shows. The
 * region refreshes as the form is filled in, "Not the same" keeps a match
 * away, "Add a copy" lands on the garment with one more copy, and Enter in
 * the name field still saves (the copy buttons are another form's, so Save
 * stays the default button). The server's side is
 * test/integration/lookalikes.spec.ts.
 */

test.use({ viewport: { width: 390, height: 844 } });

/** A new garment form filled in as a white tee: category, type, colour. */
async function fillAsWhiteTee(page: Page, name: string) {
  await page.goto('/wardrobe/new');
  await page.locator('#garment-name').fill(name);
  await page.locator('#garment-category').fill('tops');
  await page.locator('#garment-category').blur();
  const tshirt = page.locator('input[name="type"][value="t-shirt"]');
  await tshirt.check();
  await page.locator('.color-ms summary').click();
  await page.getByRole('checkbox', { name: 'white' }).check();
  await page.locator('.color-ms summary').click();
}

test('a white tee like one owned offers a copy, which can be dismissed or taken', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await signIn(page, 'lookalikes');
  const owned = await createGarment(page, 'White tee', 'tops', {
    props: '1',
    type: 't-shirt',
    color: 'white',
  });

  await fillAsWhiteTee(page, 'Another tee');
  const region = page.locator('#garment-lookalikes');
  const match = region.locator(`[data-lookalike="${owned}"]`);
  await expect(match).toBeVisible();
  await expect(match).toContainText('White tee');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  // "Not the same": gone, and a later change does not bring it back.
  await region.getByRole('button', { name: 'Not the same' }).click();
  await expect(match).toHaveCount(0);
  await page.locator('#garment-brand').fill('Uniqlo');
  await page.locator('#garment-brand').blur();
  await expect(page.locator('input[name="lookalikesDismissed"]')).toHaveValue(
    String(owned),
  );
  await expect(match).toHaveCount(0);

  // "Add a copy": one more of the garment, nothing new.
  await fillAsWhiteTee(page, 'Same tee again');
  await region.getByRole('button', { name: 'Add a copy of White tee' }).click();
  await expect(page).toHaveURL(new RegExp(`/wardrobe/${owned}(\\?|$)`));
  await expect(page.locator('#copy-added-toast')).toBeVisible();
  await expect(page.getByText('2 identical')).toBeVisible();

  // Enter in the name field saves the form: the check never blocks it.
  await fillAsWhiteTee(page, 'Enter saves');
  await expect(match).toBeVisible();
  await page.locator('#garment-name').press('Enter');
  await expect(page).toHaveURL(/\/wardrobe\/\d+/);
  await expect(page).not.toHaveURL(new RegExp(`/wardrobe/${owned}(\\?|$)`));
  await expect(page.locator('#garment-saved-toast')).toBeVisible();
  expect(errors).toEqual([]);
});
