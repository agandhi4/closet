import { test, expect } from '@playwright/test';

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
    });
    expect(login.ok()).toBe(true);
    expect(new URL(login.url()).pathname).toBe('/auth/profile');

    await page.goto('/wardrobe');
    await expect(page).toHaveURL(/\/wardrobe$/);
    await expect(page.locator('body')).toContainText(APP_NAME);

    await page.goto('/auth/profile');
    await expect(page.locator('main h1')).toHaveText(email);
  });
});
