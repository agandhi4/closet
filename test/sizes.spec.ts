import { expect, type Page, test } from '@playwright/test';
import { signIn } from './support/e2e-session';

/**
 * Sizes at phone width (#24): Profile › Sizes, its editor (measurements in
 * the unit shown, the unit switch, a brand's row) and the garment form's
 * brand hint refreshing as the brand is typed. What is stored and who may
 * see it is test/integration/sizes.spec.ts's.
 */

test.use({ viewport: { width: 390, height: 844 } });

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
}

test('sizes on the phone: the Profile section, its editor and the form’s hint', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await signIn(page, 'sizes');

  await page.goto('/auth/profile');
  await page.locator('nav a[href="#sizes"]').click();
  const section = page.locator('#sizes');
  await expect(section).toBeInViewport();
  await expect(section).toContainText('No measurements yet.');
  await section.getByRole('link', { name: 'Edit sizes' }).click();
  await expect(page).toHaveURL(/\/auth\/profile\/sizes$/);
  await expectNoSidewaysScroll(page);

  // Measurements in inches, the default.
  await page.getByLabel('Waist').fill('32');
  await page.getByLabel('Inseam').fill('32.5');
  await page.getByRole('button', { name: 'Save measurements' }).click();
  await expect(page.locator('#sizes-toast')).toContainText(
    'Measurements saved',
  );
  // The one-shot flag leaves the address.
  await expect(page).toHaveURL(/\/auth\/profile\/sizes$/);
  await expect(page.getByLabel('Waist')).toHaveValue('32');

  // The unit switch shows the same lengths in cm.
  await page.getByRole('button', { name: 'Centimeters' }).click();
  await expect(page.getByLabel('Waist')).toHaveValue('81.3');
  await expect(
    page.getByRole('button', { name: 'Centimeters' }),
  ).toHaveAttribute('aria-pressed', 'true');

  // A brand's row.
  await page.locator('#brand-size-new-brand').fill('Uniqlo');
  await page.locator('#brand-size-new-size').fill('m');
  await page.locator('#brand-size-new-note').fill('Runs big');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('#sizes-toast')).toContainText('Brand saved');
  await expect(
    page.getByRole('button', { name: 'Remove Uniqlo' }),
  ).toBeVisible();
  await expectNoSidewaysScroll(page);

  // Back to the section, which shows what was saved.
  await page.goto('/auth/profile#sizes');
  await expect(section).toContainText('82.6 cm');
  await expect(section).toContainText('Your size in Uniqlo: Medium · Runs big');
  await expectNoSidewaysScroll(page);

  // The garment form: the note follows the brand as it is typed.
  await page.goto('/wardrobe/new');
  const hint = page.locator('#brand-size-hint');
  await expect(hint).toBeEmpty();
  await page.getByLabel('Brand').fill('UNIQLO');
  await expect(hint).toContainText('Your size in Uniqlo: Medium · Runs big');
  await page.getByLabel('Brand').fill('Everlane');
  await expect(hint).toBeEmpty();
  expect(errors).toEqual([]);
});
