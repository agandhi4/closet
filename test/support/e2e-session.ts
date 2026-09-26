import type { Page } from '@playwright/test';

export const E2E_PASSWORD = 'Password123!';

/** playwright.config.ts `baseURL`: the origin every page is served from. */
export const APP_ORIGIN = 'http://localhost:3000';

/**
 * Headers for a POST made through `page.request` (the API context), which,
 * unlike the browser, sends no Origin: the app refuses a state-changing
 * request that does not name the site (the CSRF check,
 * src/web/security/same-origin.ts).
 */
export const SAME_ORIGIN = { origin: APP_ORIGIN };

let clientSeq = 0;

/**
 * SAME_ORIGIN plus a client address of its own. Login and registration are rate limited per address
 * and every spec signs up from 127.0.0.1, which is a trusted proxy by
 * default (TRUSTED_PROXIES), so each sign-up names a different forwarded
 * client instead of sharing one budget.
 */
export function signUpHeaders(): Record<string, string> {
  clientSeq += 1;
  const worker = process.env.TEST_WORKER_INDEX ?? '0';
  return {
    ...SAME_ORIGIN,
    'x-forwarded-for': `198.19.${Number(worker) % 250}.${(clientSeq % 250) + 1}`,
  };
}

/**
 * Registers a fresh user through the real endpoint, which leaves its session
 * cookie in the page's context (page.request shares the context's cookies).
 * Login is always required, so every spec that opens an app page calls this
 * first.
 */
export async function signIn(page: Page, prefix: string): Promise<string> {
  const email = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const res = await page.request.post('/auth/register', {
    form: { email, password: E2E_PASSWORD, confirmPassword: E2E_PASSWORD },
    headers: signUpHeaders(),
  });
  if (!res.ok()) {
    throw new Error(`Registering ${email} failed: ${res.status()}`);
  }
  return email;
}
