import { test, expect } from '@playwright/test';

const APP_NAME = process.env.APP_NAME || 'Closet';

/**
 * The session is resolved once per request from the access_token cookie
 * (AuthContextService, see src/main.ts). This proves the cookie set by
 * /auth/login is honoured by the redirect guard on /wardrobe, the 401 guard
 * on /auth/profile, and the navbar/profile templates that read the user.
 */
test.describe('login session', () => {
  test.skip(
    process.env.AUTH_ENABLED !== 'true',
    'needs a server started with AUTH_ENABLED=true',
  );

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

    // Anonymous: the wardrobe redirects, the profile is a 401.
    await page.goto('/wardrobe');
    await expect(page).toHaveURL(/\/auth\/login$/);
    const anonymousProfile = await page.request.get('/auth/profile');
    expect(anonymousProfile.status()).toBe(401);

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
