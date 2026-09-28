import { expect, test } from '@playwright/test';
import { createGarment, createOutfit } from './support/e2e-data';
import { signIn } from './support/e2e-session';
import { householdToday } from './support/household-today';

/**
 * Several outfits a day at phone width (#13): a day planned three times
 * through its "+ Plan" sheet (the occasion, then "Pick a saved outfit" on
 * the Saved tab, R5/R6), shown back
 * stacked in occasion order with a worn pill each, and nothing wider than
 * the screen. The server side is test/integration/occasions.spec.ts.
 */

test.use({ viewport: { width: 390, height: 844 } });

test('a three-outfit day: planned by occasion, stacked in order, each with its pill', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await signIn(page, 'occasions');
  const day = householdToday();
  // Planned in an order the page must not keep: evening, work, workout.
  // Each outfit its own garment: one garment set is one outfit (#219).
  const plans: [string, string, string][] = [
    ['Evening', 'Dinner', 'Loafers'],
    ['Work', 'Office', 'Oxfords'],
    ['Workout', 'Run', 'Trainers'],
  ];
  for (const [, name, shoes] of plans) {
    await createOutfit(
      page,
      name,
      await createGarment(page, shoes, 'footwear'),
    );
  }

  await page.goto(`/calendar?week=${day}`);
  // The day's "+ Plan" sheet (R6): the occasion, then "Pick a saved outfit"
  // lands on the Saved tab picking for that day and occasion (R5).
  const sheet = page.locator(`dialog[data-plan-sheet="${day}"]`);
  for (const [occasion, outfit] of plans) {
    await page.locator(`[data-day-plan="${day}"]`).click();
    await expect(sheet).toBeVisible();
    await expect(
      sheet.getByRole('radio', { name: 'All day', exact: true }),
    ).toBeChecked();
    await sheet.getByRole('radio', { name: occasion, exact: true }).check();
    await sheet.getByRole('button', { name: 'Pick a saved outfit' }).click();
    // The Saved tab picking for the day (R5), with the occasion chosen.
    // A GET form encodes the colon: for=day%3A<day>.
    await expect(page).toHaveURL(
      new RegExp(`/outfits\\?for=day(:|%3A)${day}&occasion=`),
    );
    await expect(page.locator(`[data-destination-day="${day}"]`)).toContainText(
      `· ${occasion}`,
    );
    await page.getByRole('button', { name: outfit, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/calendar\\?week=${day}$`));
  }

  const rows = page.locator('[data-occasion]');
  await expect(rows).toHaveCount(3);
  expect(
    await rows.evaluateAll((els) => els.map((el) => el.dataset.occasion)),
  ).toEqual(['workout', 'work', 'evening']);
  await expect(rows.nth(0)).toContainText('Workout');
  await expect(rows.nth(2)).toContainText('Evening');
  await expect(
    page.getByRole('button', { name: '+ Another outfit' }),
  ).toBeVisible();

  // Every row keeps its pill on screen at 390 px, and nothing scrolls sideways.
  const pills = page.getByRole('button', { name: 'Worn?' });
  await expect(pills).toHaveCount(3);
  for (const pill of await pills.all()) {
    const box = (await pill.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);

  // Marking the evening worn swaps its pill alone.
  await rows.nth(2).getByRole('button', { name: 'Worn?' }).click();
  await expect(
    rows.nth(2).getByRole('button', { name: '✓ Worn' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Worn?' })).toHaveCount(2);

  // The Saved tab marks what is already on the day.
  await page.locator(`[data-day-plan="${day}"]`).click();
  await sheet.getByRole('button', { name: 'Pick a saved outfit' }).click();
  await expect(
    page.getByRole('button', { name: 'Office', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText('On this day · Work', { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
