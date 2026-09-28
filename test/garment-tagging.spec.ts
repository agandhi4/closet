import { expect, type Page, test } from '@playwright/test';
import { SAME_ORIGIN, signIn } from './support/e2e-session';
import { pageErrors } from './support/page-errors';

/**
 * Tagging mode in a browser (#12, slice 12c): a tap saves and redraws the
 * chips (presets shown), Next moves on, the last card says it is done. The
 * server side is test/integration/garment-tagging.spec.ts; quick taps on a
 * slow network are test/autosave.spec.ts.
 */

test.use({ viewport: { width: 390, height: 844 } });

/**
 * Waits for a swap to settle: after Next, htmx binds the new card's
 * triggers about 20 ms after inserting it (settle), so acting on the
 * response alone can tap a chip that is not listening yet.
 */
function settled(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        document.addEventListener('htmx:afterSettle', () => resolve(), {
          once: true,
        }),
      ),
  );
}

test('tag two tees by tapping, then finish', async ({ page }) => {
  const errors = pageErrors(page);
  await signIn(page, 'garment-tagging');
  for (const name of ['First tee', 'Second tee']) {
    const res = await page.request.post('/wardrobe', {
      form: { name, category: 'tops', props: '1' },
      headers: SAME_ORIGIN,
    });
    expect(res.ok()).toBe(true);
  }

  await page.goto('/wardrobe');
  await page.getByRole('link', { name: 'Tag them' }).click();
  await expect(page.getByText('2 left to tag')).toBeVisible();
  await expect(page.getByText('Second tee')).toBeVisible();

  let swap = settled(page);
  await page.getByRole('radio', { name: 'T-shirt', exact: true }).check();
  await swap;
  // The type's presets arrive with the saved card.
  await expect(
    page.getByRole('radio', { name: 'Light', exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole('radio', { name: 'Casual', exact: true }),
  ).toBeChecked();
  await expect(page.getByText('1 left to tag')).toBeVisible();

  swap = settled(page);
  await page.getByRole('button', { name: 'Next' }).click();
  await swap;
  await expect(page.getByText('First tee')).toBeVisible();
  swap = settled(page);
  await page.getByRole('radio', { name: 'Polo', exact: true }).check();
  await swap;
  swap = settled(page);
  await page.getByRole('button', { name: 'Next' }).click();
  await swap;
  await expect(page.getByText('Every garment has its details.')).toBeVisible();
  expect(errors).toEqual([]);
});
