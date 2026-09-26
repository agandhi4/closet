import { expect, test } from '@playwright/test';
import { signIn } from './support/e2e-session';

/**
 * The garment form's properties in a browser (#12): what only htmx can
 * show, the fragment swaps after the category, a type chip and the weight
 * change. The server's side (presets, dropping what a role lacks) is
 * test/integration/garment-properties.spec.ts.
 */

test.use({ viewport: { width: 390, height: 844 } });

test('a heavyweight tee: category, type and weight fill the presets, and a choice survives', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await signIn(page, 'garment-properties');
  await page.goto('/wardrobe/new');

  // No type before a category.
  await expect(page.getByRole('group', { name: 'Type' })).toHaveCount(0);

  // Resolves once the refreshed properties have settled, not when the
  // response arrives: htmx inserts the new fields at the swap but only binds
  // their hx-trigger in the settle task (defaultSettleDelay, 20 ms later), so
  // an input typed into in between fires a change nothing listens to.
  // Started before the action it waits for (Playwright runs the evaluate
  // first), so the listener is in place when the swap settles.
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
  const category = page.locator('#garment-category');
  let answer = refreshed();
  await category.fill('tops');
  await category.blur();
  await answer;
  await expect(page.getByRole('group', { name: 'Type' })).toBeVisible();

  answer = refreshed();
  await page.getByRole('radio', { name: 'T-shirt', exact: true }).check();
  await answer;
  await expect(
    page.getByRole('radio', { name: 'Light', exact: true }),
  ).toBeChecked();

  // 6 oz is heavyweight: the warmth preset follows the weight.
  answer = refreshed();
  await page.locator('#garment-fabric-weight').fill('6');
  await page.locator('#garment-fabric-weight').blur();
  await answer;
  await expect(
    page.getByRole('radio', { name: 'Medium', exact: true }),
  ).toBeChecked();

  // A formality the user picks is theirs: a new type keeps it.
  await page.getByText('More details').click();
  await page.getByRole('radio', { name: 'Dressy', exact: true }).check();
  answer = refreshed();
  await page.getByRole('radio', { name: 'Polo', exact: true }).check();
  await answer;
  await expect(
    page.getByRole('radio', { name: 'Dressy', exact: true }),
  ).toBeChecked();

  await page.locator('#garment-name').fill('Heavy polo');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/wardrobe\/\d+/);
  await expect(page.getByText('6 oz · 203 gsm')).toBeVisible();
  await expect(page.getByText('Dressy')).toBeVisible();
  expect(errors).toEqual([]);
});
