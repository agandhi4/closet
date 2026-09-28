import { expect, test } from '@playwright/test';
import { signIn } from './support/e2e-session';
import { pageErrors } from './support/page-errors';

/**
 * The care label and the repair log at phone width (#23): what only a
 * browser shows, the materials filling the label through the properties
 * fragment, the label on the garment page, and logging a repair from the
 * edit page back to the garment page. The server's side is
 * test/integration/garment-care.spec.ts.
 */

test.use({ viewport: { width: 390, height: 844 } });

test('wool fills the care label, a repair is logged, and both fit the phone', async ({
  page,
}) => {
  const errors = pageErrors(page);
  await signIn(page, 'garment-care');
  await page.goto('/wardrobe/new');

  /** Resolves once the refreshed properties (both blocks) have settled. */
  const refreshed = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const settled = (event: Event) => {
            if ((event.target as Element).id !== 'garment-props-main') return;
            document.removeEventListener('htmx:afterSettle', settled);
            resolve();
          };
          document.addEventListener('htmx:afterSettle', settled);
        }),
    );
  await page.locator('#garment-name').fill('Merino jumper');
  let answer = refreshed();
  await page.locator('#garment-category').fill('tops');
  await page.locator('#garment-category').blur();
  await answer;
  await page.getByText('More details').click();
  const label = page.getByRole('group', { name: 'Care label' });
  await expect(label).toBeVisible();

  answer = refreshed();
  await page.getByRole('checkbox', { name: 'Wool', exact: true }).check();
  await answer;
  await expect(
    label.getByRole('radio', { name: 'Hand wash', exact: true }),
  ).toBeChecked();
  await expect(
    label.getByRole('radio', { name: 'Dry flat', exact: true }),
  ).toBeChecked();
  // A choice of the person's own, which the save keeps.
  answer = refreshed();
  await label
    .getByRole('radio', { name: 'Dry clean only', exact: true })
    .check();
  await answer;
  // Chips wrap inside the phone's width: nothing scrolls sideways.
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/wardrobe\/\d+/);
  const care = page.locator('#garment-care');
  await expect(care.getByText('Hand wash')).toBeVisible();
  await expect(care.getByText('Dry clean only')).toBeVisible();
  const repairs = page.locator('#garment-repairs');
  await expect(repairs.getByText('Nothing logged yet.')).toBeVisible();

  await repairs.getByRole('link', { name: 'Log a repair' }).click();
  await expect(page).toHaveURL(/\/edit#garment-repairs$/);
  await page.getByRole('radio', { name: 'Alteration', exact: true }).check();
  await page.locator('#repair-note').fill('Sleeves shortened');
  await page.locator('#repair-cost').fill('18');
  await page.getByRole('button', { name: 'Log it' }).click();

  await expect(page).toHaveURL(/\/wardrobe\/\d+#garment-repairs$/);
  await expect(page.locator('#repair-saved-toast')).toBeVisible();
  await expect(repairs.getByText('Sleeves shortened')).toBeVisible();
  await expect(repairs.getByText('Spent on it: $18.00')).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
