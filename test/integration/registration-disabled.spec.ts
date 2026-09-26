import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { user } from '../../src/db/schema';
import { createTestApp, TEST_PASSWORD, TestApp, uniqueClient } from './harness';

/**
 * DISABLE_REGISTRATION=true (production's setting once the household has its
 * accounts): every registration route sends the visitor to the login page
 * and creates nothing. Own file: the env is read once per process. The
 * harness seeds its owner through the database here.
 */
describe('registration disabled', () => {
  let t: TestApp;
  const email = 'walk-in@example.com';

  const accounts = async () =>
    (
      await t.db.select({ n: count() }).from(user).where(eq(user.email, email))
    )[0].n;

  beforeAll(async () => {
    t = await createTestApp({ DISABLE_REGISTRATION: 'true' });
  });

  afterAll(() => t?.cleanup());

  it.each([
    ['GET', '/auth/register'],
    ['POST', '/auth/register'],
    ['POST', '/auth/validate/register'],
  ] as const)('%s %s redirects to the login page', async (method, url) => {
    const res = await t.inject({
      method,
      url,
      payload:
        method === 'POST'
          ? { email, password: TEST_PASSWORD, confirmPassword: TEST_PASSWORD }
          : undefined,
      headers: uniqueClient(),
      anonymous: true,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/auth/login');
    expect(res.cookies).toHaveLength(0);
    expect(await accounts()).toBe(0);
  });

  it('the login page offers no registration', async () => {
    const res = await t.inject({
      method: 'GET',
      url: '/auth/login',
      anonymous: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('href="/auth/register"');
  });

  it('existing accounts still sign in', async () => {
    const res = await t.inject({
      method: 'GET',
      url: '/auth/profile',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(t.owner.email);
  });
});
