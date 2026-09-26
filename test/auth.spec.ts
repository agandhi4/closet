import { test, expect } from '@playwright/test';
import { E2E_PASSWORD, signIn, signUpHeaders } from './support/e2e-session';

const APP_NAME = process.env.APP_NAME || 'Closet';

/**
 * The session is resolved once per request from the access_token cookie
 * (AuthContextService, see src/app.ts). This proves the cookie set by
 * /auth/login is honoured by SessionGuard on /wardrobe and /auth/profile and
 * by the navbar/profile templates that read the user.
 */
test.describe('login session', () => {
  test('cookie from /auth/login sticks across wardrobe and profile', async ({
    page,
  }) => {
    const email = `auth-test-${Date.now()}@example.com`;
    const password = 'Password123!';

    const register = await page.request.post('/auth/register', {
      form: { email, password, confirmPassword: password },
      headers: signUpHeaders(),
    });
    expect(register.ok()).toBe(true);
    await page.context().clearCookies();

    // Anonymous: every app page redirects to the login page.
    await page.goto('/wardrobe');
    await expect(page).toHaveURL(/\/auth\/login$/);
    await page.goto('/auth/profile');
    await expect(page).toHaveURL(/\/auth\/login$/);

    // page.request shares the browser context's cookie jar, so the cookie
    // set here is what the page sends on the navigations below.
    const login = await page.request.post('/auth/login', {
      form: { email, password },
      headers: signUpHeaders(),
    });
    expect(login.ok()).toBe(true);
    expect(new URL(login.url()).pathname).toBe('/auth/profile');

    await page.goto('/wardrobe');
    await expect(page).toHaveURL(/\/wardrobe$/);
    await expect(page.locator('body')).toContainText(APP_NAME);

    await page.goto('/auth/profile');
    await expect(page.locator('main h1')).toHaveText(email);
  });

  // A refused change answers 400, which htmx would not swap into a boosted
  // page: this proves the unboosted form shows the error instead of nothing.
  test('change password: a wrong current password shows the error, the right one keeps the session', async ({
    page,
  }) => {
    const email = await signIn(page, 'change-password');
    const newPassword = 'Changed456!';

    await page.goto('/auth/profile');
    await page.getByRole('link', { name: 'Change Password' }).click();
    await expect(page).toHaveURL(/\/auth\/change-password$/);

    await page.locator('#currentPassword').fill('NotMyPassword1');
    await page.locator('#newPassword').fill(newPassword);
    await page.locator('#confirmPassword').fill(newPassword);
    await page.getByRole('button', { name: 'Change Password' }).click();
    await expect(page.locator('main')).toContainText(
      'Current password is incorrect',
    );

    await page.locator('#currentPassword').fill(E2E_PASSWORD);
    await page.locator('#newPassword').fill(newPassword);
    await page.locator('#confirmPassword').fill(newPassword);
    await page.getByRole('button', { name: 'Change Password' }).click();
    await expect(page).toHaveURL(/\/auth\/profile\?passwordChanged=1$/);
    await expect(page.locator('main [role="status"]')).toBeVisible();

    // Still signed in on a full reload, with the replacement cookie.
    await page.goto('/auth/profile');
    await expect(page.locator('main h1')).toHaveText(email);
  });
});
