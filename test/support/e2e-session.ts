import type { Page } from '@playwright/test';

export const E2E_PASSWORD = 'Password123!';

/**
 * Registers a fresh user through the real endpoint, which leaves its session
 * cookie in the page's context (page.request shares the context's cookies).
 * With AUTH_ENABLED=false the server ignores the session, so specs that call
 * this run unchanged in either mode. CI runs the browser tier with auth on,
 * as production does.
 */
export async function signIn(page: Page, prefix: string): Promise<string> {
  const email = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await page.request.post('/auth/register', {
    form: { email, password: E2E_PASSWORD, confirmPassword: E2E_PASSWORD },
  });
  return email;
}
