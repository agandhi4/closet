import { expect, test } from '@playwright/test';
import {
  addPhotographedGarment,
  createGarment,
  createOutfitOf,
} from './support/e2e-data';
import { expectCollagePiecesInsidePlinths } from './support/collage-fit';
import { SAME_ORIGIN, signIn } from './support/e2e-session';
import { pageErrors } from './support/page-errors';

/**
 * Planning an outfit on the calendar from its page: the plan sheet (htmx,
 * an inline handler for the occasion) posts and the app lands on that week;
 * then "Plan my week", after which Saved still opens on the person's outfit
 * (#659) and the planner's are one tab away; a layered outfit's collage
 * stays inside its cell (#663).
 * The calendar's own behaviour is test/integration/calendar.spec.ts.
 */

test('the outfit page plans the outfit from its sheet and lands on that week; Plan my week leaves Saved to the person', async ({
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

  // #659: "Plan my week" fills the week with one-offs, and Saved still
  // opens on the outfit the person made; the planner's sit behind
  // "Worn and planned".
  await createGarment(page, 'Sheet jeans', 'bottoms');
  const week = Object.fromEntries(
    [0, 1, 2, 3, 4, 5, 6].map((day) => [`day-${day}`, 'all-day']),
  );
  const template = await page.request.post('/auth/profile/week', {
    form: week,
    headers: SAME_ORIGIN,
  });
  expect(template.ok()).toBe(true);
  const planned = await page.request.post('/calendar/plan-week', {
    headers: SAME_ORIGIN,
  });
  expect(planned.url()).toMatch(/planned=\d+/);
  await page.goto('/outfits');
  const tiles = page.locator('#saved-outfits li');
  await expect(tiles).toHaveCount(1);
  await expect(tiles.first()).toContainText('Sheet outfit');
  await page.getByRole('tab', { name: 'Worn and planned' }).click();
  await expect(page).toHaveURL(/show=one-offs/);
  await expect(tiles.first()).toBeVisible();
  await expect(tiles.first()).not.toContainText('Sheet outfit');

  // #663: a layer over a top in the plan's cells never spills out of the
  // plinth: the month's 48 px cells and the week's rows at 390 px, the
  // week's columns at 1280 px.
  const coat = await addPhotographedGarment(page, 'Fit coat', 'outerwear');
  // The top has no photo: its hanger placeholder must fit the cell too.
  const tee = await createGarment(page, 'Fit tee', 'tops');
  await createOutfitOf(
    page,
    'Layered',
    [
      { id: coat, category: 'outerwear' },
      { id: tee, category: 'tops' },
    ],
    '2030-10-11',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/calendar/month?month=2030-10');
  await expect(page.locator('[data-collage="cell"] img')).toHaveCount(1);
  await expectCollagePiecesInsidePlinths(page);
  await page.goto('/calendar?week=2030-10-10');
  await expect(page.locator('[data-collage="cell"] img')).toHaveCount(1);
  await expectCollagePiecesInsidePlinths(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expectCollagePiecesInsidePlinths(page);
  expect(errors).toEqual([]);
});
