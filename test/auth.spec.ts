import { expect, test } from '@playwright/test';
import { E2E_PASSWORD, signUpHeaders } from './support/e2e-session';

const APP_NAME = process.env.APP_NAME || 'Closet';

/**
 * The account's whole loop through the real forms: signed out, the root is
 * the login page (no console errors); the registration form signs the new
 * account in; Profile's sign-out (a POST) ends it; the login form, with the
 * right password after a wrong one, signs back in. The account forms post
 * natively (no htmx), which is what lets a browser save the password and
 * what makes a refusal one page, not a page swapped into a page. Every
 * other account route is test/integration/account.spec.ts and auth.spec.ts.
 */
test('register through the form, sign out from Profile, sign back in', async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  // Login and registration are rate limited per address: this browser's
  // posts name a client of their own (signUpHeaders).
  await page.setExtraHTTPHeaders({
    'x-forwarded-for': signUpHeaders()['x-forwarded-for'],
  });

  // Signed out, "/" is a 302 to the login page.
  await page.goto('/');
  await expect(page).toHaveURL(/\/auth\/login$/);
  await expect(page.locator('body')).toContainText(APP_NAME);

  const email = `register-form-${Date.now()}@example.com`;
  await page.goto('/auth/register');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('#confirmPassword').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Register' }).click();
  await expect(page).toHaveURL(/\/auth\/profile$/);
  await expect(page.locator('#account')).toContainText(email);

  // The avatar opens Profile, whose sign-out signs out (#82).
  await page.goto('/wardrobe');
  await expect(page.locator('#avatar')).toHaveText(
    email.charAt(0).toUpperCase(),
  );
  await page.locator('#avatar').click();
  await page
    .locator('#sign-out')
    .getByRole('button', { name: 'Logout' })
    .click();
  await expect(page).toHaveURL(/\/auth\/login$/);
  await page.goto('/wardrobe');
  await expect(page).toHaveURL(/\/auth\/login$/);

  // A refused login is one page with a specific message and the email kept.
  await page.locator('#email').fill(email);
  await page.locator('#password').fill('NotThePassword1');
  const refusal = page.waitForResponse(
    (response) =>
      response.url().endsWith('/auth/login') &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Login' }).click();
  expect((await refusal).status()).toBe(401);
  await expect(page.locator('[role="alert"]')).toHaveText(
    'Incorrect email or password',
  );
  await expect(page.locator('form')).toHaveCount(1);
  await expect(page.locator('#email')).toHaveValue(email);

  await page.locator('#password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page).toHaveURL(/\/auth\/profile$/);
  await expect(page.locator('#account')).toContainText(email);
  // The refusal's 401 is the one console error Chromium logs (a document
  // with an error status); anything else is a page script failing.
  expect(consoleErrors, consoleErrors.join('\n')).toEqual([
    'Failed to load resource: the server responded with a status of 401 (Unauthorized)',
  ]);
});
