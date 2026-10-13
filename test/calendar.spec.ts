import { expect, test } from '@playwright/test';
import { createGarment } from './support/e2e-data';
import { SAME_ORIGIN, signIn } from './support/e2e-session';
import { pageErrors } from './support/page-errors';

/**
 * Planning an outfit on the calendar from its page: the plan sheet (htmx,
 * an inline handler for the occasion) posts and the app lands on that week.
 * The calendar's own behaviour is test/integration/calendar.spec.ts.
 */

test('the outfit page plans the outfit from its sheet and lands on that week', async ({
  page,
}) => {
  const errors = pageErrors(page, { console: true });
  await signIn(page, 'client-plan-sheet');
  const garment = await createGarment(page, 'Sheet tee', 'tops');
  const res = await page.request.post('/outfits', {
    form: { name: 'Sheet outfit', category: 'tops', garmentId: `${garment}` },
    headers: SAME_ORIGIN,
  });
  expect(res.ok()).toBe(true);
  await page.goto(res.url());

  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  const sheet = page.locator('#outfit-plan-sheet');
  await expect(sheet).toBeVisible();
  await sheet.locator('input[name="date"]').fill('2030-10-10');
  await sheet.getByRole('radio', { name: 'Evening' }).check();
  await sheet.getByRole('button', { name: 'Plan it' }).click();

  await expect(page).toHaveURL(/\/calendar\?week=2030-10-10/);
  await expect(page.getByText('Sheet outfit').first()).toBeVisible();
  expect(errors).toEqual([]);
});
