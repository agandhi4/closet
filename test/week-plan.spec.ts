import { expect, type Page, test } from '@playwright/test';
import { createGarment } from './support/e2e-data';
import { signIn } from './support/e2e-session';

/**
 * The weekly auto-plan (#16) at phone width, what only a browser shows: the
 * Profile's week template set with its controls, "Plan my week" landing on
 * the calendar with its banner and the Auto rows, and Undo through its
 * confirm (test/integration/week-plan.spec.ts has the behavior, the
 * re-plan included).
 */

test.use({ viewport: { width: 390, height: 844 } });

/** Five tops (three of each), three bottoms and two shoes: a week and more. */
async function closet(page: Page): Promise<void> {
  const pieces: [string, string, string][] = [
    ...['white', 'grey', 'black', 'beige', 'brown'].map(
      (color): [string, string, string] => [`${color} tee`, 'tops', color],
    ),
    ['Jeans', 'bottoms', 'blue'],
    ['Black trousers', 'bottoms', 'black'],
    ['Chinos', 'bottoms', 'beige'],
    ['Sneakers', 'footwear', 'white'],
    ['Boots', 'footwear', 'brown'],
  ];
  for (const [name, category, color] of pieces) {
    await createGarment(page, name, category, {
      props: '1',
      care: '1',
      quantity: category === 'tops' ? '3' : '1',
      formality: '2',
      pattern: 'solid',
      color,
    });
  }
}

/** No element of the page is wider than the phone. */
async function expectNoSideScroll(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

test.describe('Plan my week', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, 'week-plan');
    await closet(page);
  });

  test('sets the week on the Profile, plans it from the calendar, and undoes it', async ({
    page,
  }) => {
    await page.goto('/auth/profile');
    const week = page.locator('#week');
    await expect(week).toBeVisible();
    for (const weekday of [
      'Sunday',
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
    ]) {
      await week
        .getByLabel(`${weekday}: the outfit for the day`)
        .selectOption('all-day');
    }
    await week
      .getByRole('group', { name: 'Tuesday: also' })
      .getByRole('checkbox', { name: 'Evening' })
      .check();
    await week.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Week saved')).toBeVisible();
    await expect(
      page.getByLabel('Tuesday: the outfit for the day'),
    ).toHaveValue('all-day');
    await expectNoSideScroll(page);

    await page.goto('/calendar');
    await page.getByRole('button', { name: 'Plan my week' }).click();
    const banner = page.locator('#planned-week');
    await expect(banner).toBeVisible();
    await expect(banner.getByRole('heading')).toContainText(
      /Planned \d+ outfits? for your week/,
    );
    const planned = await banner.locator('[data-entry-id]').count();
    // Seven all-day slots and Tuesday's evening, less today's slots whose
    // window has ended: six late on a Tuesday (both of today's gone, the
    // next Tuesday outside the window), pinned in
    // test/integration/week-plan.spec.ts.
    expect(planned).toBeGreaterThanOrEqual(6);
    // The one-shot flag leaves the address; the week marks the planner's rows.
    await expect(page).toHaveURL(/\/calendar$/);
    await expect(page.locator('[data-auto]').first()).toBeVisible();
    await expectNoSideScroll(page);

    page.once('dialog', (dialog) => void dialog.accept());
    await banner.getByRole('button', { name: 'Undo' }).click();
    await expect(
      page.getByText(`Plan undone: ${planned} removed`),
    ).toBeVisible();
    await expect(page.locator('[data-auto]')).toHaveCount(0);
  });

  test('without a week, sends to the Profile to set one', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Plan my week' }).click();
    await expect(page).toHaveURL(/\/auth\/profile#week$/);
    await expect(page.locator('#week')).toBeInViewport();
  });
});
