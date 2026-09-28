import { expect, test } from '@playwright/test';
import { signIn } from './support/e2e-session';

/**
 * The link page in a real browser (#120): what a share sheet or a copy
 * gives is often the product's title and then its link, and the field must
 * let that through to the server, which finds the link (linkIn). The
 * prefilled form itself needs a shop to fetch from, which only the
 * integration tier has (test/integration/link-import.spec.ts).
 */

test.use({ viewport: { width: 390, height: 844 } });

test('the link field posts shared text with words around the link', async ({
  page,
}) => {
  await signIn(page, 'link-field');
  await page.goto('/wardrobe/new/from-link');

  const field = page.getByLabel('Link');
  // `.invalid` never resolves, so the answer is the link page again with
  // the server's refusal: proof the post left the browser, which a
  // type="url" field's own validation refused before sending.
  await field.fill('Oxford Shirt | Shop https://shop.invalid/oxford');
  const [response] = await Promise.all([
    page.waitForResponse(
      (res) =>
        res.request().method() === 'POST' &&
        new URL(res.url()).pathname === '/wardrobe/new/from-link',
    ),
    page.getByRole('button', { name: 'Fetch' }).click(),
  ]);

  expect(response.status()).toBeGreaterThanOrEqual(400);
  await expect(page.locator('#link-url-error')).toBeVisible();
  await expect(page.getByLabel('Link')).toHaveValue(
    'Oxford Shirt | Shop https://shop.invalid/oxford',
  );
});
