import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { User } from '../../src/dal/entity/user.entity';
import { createTestApp, TEST_PASSWORD, TestApp, uniqueClient } from './harness';
import { expectFragment, expectFullPage } from './pages';

/**
 * Account flows, end to end through the real controllers: inline
 * registration validation, logout, changing the email, the delete-account
 * page, login failures, and changing the password. Sessions are asserted
 * through the `pwf` password fingerprint AuthContextService checks on every
 * request.
 */

const NEW_PASSWORD = 'NewPassword456!';

/** The raw Set-Cookie header for the session, as a browser would parse it. */
function sessionSetCookie(res: LightMyRequestResponse): string {
  const header = res.headers['set-cookie'];
  const all = Array.isArray(header) ? header : [header ?? ''];
  const cookie = all.find((c) => c.startsWith('access_token='));
  if (!cookie)
    throw new Error(`No access_token Set-Cookie: ${all.join(' | ')}`);
  return cookie;
}

describe('account', () => {
  let t: TestApp;

  // Each login-driven test gets its own client address (TRUSTED_PROXIES
  // trusts X-Forwarded-For from inject's 127.0.0.1), so no test's attempts
  // count towards another's rate limit.
  const postLogin = (
    email: string,
    password: string,
    client = uniqueClient(),
  ) =>
    t.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password },
      headers: client,
      anonymous: true,
    });

  const sessionCookie = (res: LightMyRequestResponse) => {
    const token = res.cookies.find((c) => c.name === 'access_token');
    return token?.value ? `access_token=${token.value}` : undefined;
  };

  const profileStatus = async (cookie: string) =>
    (
      await t.inject({
        method: 'GET',
        url: '/auth/profile',
        headers: { cookie },
      })
    ).statusCode;

  const passwordHash = async (email: string) =>
    (await t.em().findOneOrFail(User, { email })).password;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  describe('POST /auth/validate/register', () => {
    const validate = (payload: Record<string, string>) =>
      t.inject({
        method: 'POST',
        url: '/auth/validate/register',
        payload,
        headers: { 'hx-request': 'true' },
      });

    it('marks each invalid field with a translated message', async () => {
      const res = await validate({
        email: 'not-an-email',
        password: 'short',
        confirmPassword: 'different',
      });
      expect(res.statusCode).toBeLessThan(300);
      expect(
        res.body.match(/class="text-error"/g)?.length,
      ).toBeGreaterThanOrEqual(3);
      expect(res.body).not.toMatch(/\blang\.(validation\.)?[A-Z_]{3,}/);
    });

    it('a valid body has no errors and clears every slot', async () => {
      const res = await validate({
        email: 'valid@example.com',
        password: TEST_PASSWORD,
        confirmPassword: TEST_PASSWORD,
      });
      expect(res.statusCode).toBeLessThan(300);
      expect(res.body).not.toContain('class="text-error"');
      expect(res.body.match(/hx-swap-oob="true"/g)).toHaveLength(3);
      expect(await t.em().count(User, { email: 'valid@example.com' })).toBe(0);
    });

    // Only the message slots, swapped out of band by id: never the page
    // (which nested a second navbar and form into the fieldset), and never
    // the inputs or the button, which a user may be typing in or clicking.
    it('answers with the message slots alone, out of band', async () => {
      const res = await validate({
        email: 'not-an-email',
        password: 'short',
        confirmPassword: 'different',
      });
      expect(res.statusCode).toBe(200);
      expectFragment(res);
      for (const field of ['email', 'password', 'confirmPassword']) {
        expect(res.body).toMatch(
          new RegExp(`<div id="${field}-errors"[^>]*hx-swap-oob="true"`),
        );
      }
      expect(res.body).not.toMatch(/<(input|button|fieldset)\b/);
      // Passwords are never echoed back.
      expect(res.body).not.toContain('different');

      const page = await t.inject({
        method: 'GET',
        url: '/auth/register',
        anonymous: true,
      });
      expect(page.body).toMatch(
        /<fieldset\b[^>]*hx-post="\/auth\/validate\/register" hx-trigger="change" hx-swap="none"/,
      );
      expect(page.body).toContain('<div id="email-errors"');
    });
  });

  describe('login', () => {
    const email = 'login@example.com';

    beforeAll(() => t.register(email));

    it('a wrong password re-renders the form without a session', async () => {
      const res = await postLogin(email, 'WrongPassword1');
      expect(res.body).toContain('action="/auth/login"');
      expect(sessionCookie(res)).toBeUndefined();
    });

    it('a wrong password answers 401 with one page and a specific message', async () => {
      const res = await postLogin(email, 'WrongPassword1');
      expect(res.statusCode).toBe(401);
      expectFullPage(res);
      // Once: a boosted post used to swap a whole page into the page.
      expect(res.body.match(/<h1\b/g)).toHaveLength(1);
      expect(
        res.body.match(/<form\b[^>]*action="\/auth\/login"/g),
      ).toHaveLength(1);
      expect(res.body).toContain('Incorrect email or password');
      // The address is kept for the retry; the password never is.
      expect(res.body).toContain(`value="${email}"`);
      expect(res.body).not.toContain('WrongPassword1');
    });

    it('an unknown email gets the same answer as a wrong password', async () => {
      const res = await postLogin('nobody@example.com', 'WrongPassword1');
      expect(res.statusCode).toBe(401);
      expect(res.body).toContain('Incorrect email or password');
    });

    it('the address is matched case-insensitively', async () => {
      const res = await postLogin('Login@Example.COM', TEST_PASSWORD);
      expect(res.statusCode).toBe(302);
      expect(sessionCookie(res)).toBeDefined();
    });

    it('the session cookie lives 365 days, SameSite=Lax, never Secure', async () => {
      const res = await postLogin(email, TEST_PASSWORD);
      expect(res.statusCode).toBe(302);
      const cookie = sessionSetCookie(res);
      expect(cookie).toMatch(/;\s*Max-Age=31536000(;|$)/);
      expect(cookie).toMatch(/;\s*SameSite=Lax(;|$)/i);
      expect(cookie).not.toMatch(/;\s*Secure(;|$)/i);
    });

    it('a sixth login attempt within a minute is refused with 429', async () => {
      const client = uniqueClient();
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        statuses.push(
          (await postLogin(email, 'WrongPassword1', client)).statusCode,
        );
      }
      expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
      // Even the right password waits out the window from that address...
      expect((await postLogin(email, TEST_PASSWORD, client)).statusCode).toBe(
        429,
      );
      // ...while another address is unaffected.
      expect((await postLogin(email, TEST_PASSWORD)).statusCode).toBe(302);
    });

    it('the login form is one a password manager can save', async () => {
      const res = await t.inject({
        method: 'GET',
        url: '/auth/login',
        anonymous: true,
      });
      expect(res.body).toMatch(
        /<form method="post" action="\/auth\/login" hx-boost="false"/,
      );
      expect(res.body).toMatch(
        /<input id="email" name="email" type="email"[^>]*autocomplete="username"/,
      );
      expect(res.body).toMatch(
        /<input id="password" name="password" type="password"[^>]*autocomplete="current-password"/,
      );
    });
  });

  describe('logout', () => {
    it('clears the session cookie and the app sends the next page to login', async () => {
      const cookie = await t.register('logout@example.com');
      expect(await profileStatus(cookie)).toBe(200);

      const res = await t.inject({
        method: 'GET',
        url: '/auth/logout',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/');
      const cleared = res.cookies.find((c) => c.name === 'access_token');
      expect(cleared?.value).toBe('');
      expect(cleared?.path).toBe('/');
      expect(cleared?.expires?.getTime()).toBeLessThanOrEqual(Date.now());

      // What the browser sends after applying that Set-Cookie: nothing.
      const next = await t.inject({
        method: 'GET',
        url: '/wardrobe',
        anonymous: true,
      });
      expect(next.statusCode).toBe(302);
      expect(next.headers.location).toBe('/auth/login');
    });
  });

  describe('update email', () => {
    const oldEmail = 'before@example.com';
    const newEmail = 'after@example.com';
    let cookie: string;
    let userId: number;

    beforeAll(async () => {
      cookie = await t.register(oldEmail);
      userId = (await t.em().findOneOrFail(User, { email: oldEmail })).id;
    });

    it('GET /auth/update-email renders the form', async () => {
      const res = await t.inject({
        method: 'GET',
        url: '/auth/update-email',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('action="/auth/update-email"');
      expect(res.body).toContain('name="confirmEmail"');
    });

    it('POST /auth/validate/update-email flags a mismatched confirmation', async () => {
      const bad = await t.inject({
        method: 'POST',
        url: '/auth/validate/update-email',
        payload: { email: newEmail, confirmEmail: 'other@example.com' },
        headers: { cookie, 'hx-request': 'true' },
      });
      expect(bad.statusCode).toBe(200);
      expectFragment(bad);
      expect(bad.body).toContain('class="text-error"');
      expect(bad.body).not.toMatch(/\blang\.(validation\.)?[A-Z_]{3,}/);

      const good = await t.inject({
        method: 'POST',
        url: '/auth/validate/update-email',
        payload: { email: newEmail, confirmEmail: newEmail },
        headers: { cookie, 'hx-request': 'true' },
      });
      expect(good.body).not.toContain('class="text-error"');
    });

    it('a mismatched submission is a 400 re-render and changes nothing', async () => {
      const res = await t.inject({
        method: 'POST',
        url: '/auth/update-email',
        payload: { email: newEmail, confirmEmail: 'other@example.com' },
        headers: { cookie },
      });
      expect(res.statusCode).toBe(400);
      expectFullPage(res);
      expect(res.body).toContain('class="text-error"');
      expect((await t.em().findOneOrFail(User, userId)).email).toBe(oldEmail);
    });

    it('POST /auth/update-email changes the row; only the new address logs in', async () => {
      const res = await t.inject({
        method: 'POST',
        url: '/auth/update-email',
        payload: { email: newEmail, confirmEmail: newEmail },
        headers: { cookie },
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/auth/profile');
      expect((await t.em().findOneOrFail(User, userId)).email).toBe(newEmail);

      const profile = await t.inject({
        method: 'GET',
        url: '/auth/profile',
        headers: { cookie },
      });
      expect(profile.statusCode).toBe(200);
      expect(profile.body).toContain(newEmail);

      expect(
        sessionCookie(await postLogin(oldEmail, TEST_PASSWORD)),
      ).toBeUndefined();
      expect(
        sessionCookie(await postLogin(newEmail, TEST_PASSWORD)),
      ).toBeDefined();
    });

    it('an address another account uses, in any case, is a 400 field error', async () => {
      await t.register('taken@example.com');
      const res = await t.inject({
        method: 'POST',
        url: '/auth/update-email',
        payload: {
          email: 'Taken@Example.com',
          confirmEmail: 'Taken@Example.com',
        },
        headers: { cookie },
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('Another account already uses this email');
      expect((await t.em().findOneOrFail(User, userId)).email).toBe(newEmail);
    });

    it('a new address is stored lower case', async () => {
      const res = await t.inject({
        method: 'POST',
        url: '/auth/update-email',
        payload: {
          email: 'Mixed@Example.com',
          confirmEmail: 'mixed@example.COM',
        },
        headers: { cookie },
      });
      expect(res.statusCode).toBe(302);
      expect((await t.em().findOneOrFail(User, userId)).email).toBe(
        'mixed@example.com',
      );
    });
  });

  it('GET /auth/delete-account renders the confirmation form', async () => {
    const cookie = await t.register('leaving@example.com');
    const res = await t.inject({
      method: 'GET',
      url: '/auth/delete-account',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('action="/auth/delete-account"');
    // A native post that asks first: its refusal page must be visible.
    expect(res.body).toContain('hx-boost="false"');
    expect(res.body).toContain(
      'data-confirm="Are you sure you want to delete your account?"',
    );
    expect(await t.em().count(User, { email: 'leaving@example.com' })).toBe(1);
  });

  describe('change password', () => {
    const email = 'changer@example.com';
    let cookie: string;

    const changePassword = (session: string, payload: Record<string, string>) =>
      t.inject({
        method: 'POST',
        url: '/auth/change-password',
        payload,
        headers: { cookie: session },
      });

    beforeAll(async () => {
      cookie = await t.register(email);
    });

    it('GET /auth/change-password renders the form, linked from the profile', async () => {
      const page = await t.inject({
        method: 'GET',
        url: '/auth/change-password',
        headers: { cookie },
      });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('action="/auth/change-password"');
      for (const field of [
        'currentPassword',
        'newPassword',
        'confirmPassword',
      ]) {
        expect(page.body).toContain(`name="${field}"`);
      }

      const profile = await t.inject({
        method: 'GET',
        url: '/auth/profile',
        headers: { cookie },
      });
      expect(profile.body).toContain('href="/auth/change-password"');
      expect(profile.body).not.toContain('/auth/reset');
    });

    it('a wrong current password is a 400 with a translated error; the hash is unchanged', async () => {
      const hashBefore = await passwordHash(email);
      const res = await changePassword(cookie, {
        currentPassword: 'NotMyPassword1',
        newPassword: NEW_PASSWORD,
        confirmPassword: NEW_PASSWORD,
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('Current password is incorrect');
      expect(res.body).not.toMatch(/\blang\.[A-Z_]{3,}/);
      expect(res.body).not.toContain(NEW_PASSWORD);
      expect(sessionCookie(res)).toBeUndefined();
      expect(await passwordHash(email)).toBe(hashBefore);
      expect(await profileStatus(cookie)).toBe(200);
    });

    it.each([
      [
        'a mismatched confirmation',
        { newPassword: NEW_PASSWORD, confirmPassword: 'Different456!' },
        'confirmPassword',
        'Passwords must match',
      ],
      [
        'a too-short password',
        { newPassword: 'Ab1', confirmPassword: 'Ab1' },
        'newPassword',
        'at least 8 characters',
      ],
      [
        'a password without a digit or capital',
        { newPassword: 'lowercaseonly', confirmPassword: 'lowercaseonly' },
        'newPassword',
        'one uppercase letter',
      ],
    ])(
      '%s is a 400 validation re-render; the hash is unchanged',
      async (_label, fields, field, message) => {
        const hashBefore = await passwordHash(email);
        const res = await changePassword(cookie, {
          currentPassword: TEST_PASSWORD,
          ...fields,
        });
        expect(res.statusCode).toBe(400);
        expect(res.body).toContain(message);
        // The error marks the field it belongs to, and only that one.
        expect(res.body).toMatch(
          new RegExp(`input-error">\\s*<input\\s+id="${field}"`),
        );
        expect(res.body.match(/input input-error/g)).toHaveLength(1);
        expect(res.body).not.toMatch(/\blang\.(validation\.)?[A-Z_]{3,}/);
        expect(await passwordHash(email)).toBe(hashBefore);
      },
    );

    it('changes the hash, keeps this session signed in and ends every other session', async () => {
      const otherDevice = await t.login(email);
      expect(await profileStatus(otherDevice)).toBe(200);
      const hashBefore = await passwordHash(email);

      const res = await changePassword(cookie, {
        currentPassword: TEST_PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmPassword: NEW_PASSWORD,
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/auth/profile?passwordChanged=1');
      expect(await passwordHash(email)).not.toBe(hashBefore);

      // This browser got a replacement cookie carrying the new fingerprint.
      const replacement = sessionCookie(res);
      expect(replacement).toBeDefined();
      expect(sessionSetCookie(res)).toMatch(/HttpOnly/i);
      const profile = await t.inject({
        method: 'GET',
        url: '/auth/profile?passwordChanged=1',
        headers: { cookie: replacement! },
      });
      expect(profile.statusCode).toBe(200);
      expect(profile.body).toContain('alert-success');

      // Every token issued before the change is dead: the one this request
      // was made with and the other device's. A page is redirected, an htmx
      // fragment gets a 401 with HX-Redirect.
      for (const old of [cookie, otherDevice]) {
        expect(await profileStatus(old)).toBe(302);
        const fragment = await t.inject({
          method: 'GET',
          url: '/wardrobe',
          headers: { cookie: old, 'hx-request': 'true' },
        });
        expect(fragment.statusCode).toBe(401);
        expect(fragment.headers['hx-redirect']).toBe('/auth/login');
      }

      // Only the new password logs in now.
      expect(
        sessionCookie(await postLogin(email, TEST_PASSWORD)),
      ).toBeUndefined();
      expect(sessionCookie(await postLogin(email, NEW_PASSWORD))).toBeDefined();
    });

    it('anonymously: the page redirects to login and the post changes nothing', async () => {
      const page = await t.inject({
        method: 'GET',
        url: '/auth/change-password',
        anonymous: true,
      });
      expect(page.statusCode).toBe(302);
      expect(page.headers.location).toBe('/auth/login');

      const hashBefore = await passwordHash(email);
      const post = await t.inject({
        method: 'POST',
        url: '/auth/change-password',
        payload: {
          currentPassword: NEW_PASSWORD,
          newPassword: 'Hijacked789!',
          confirmPassword: 'Hijacked789!',
        },
        anonymous: true,
      });
      expect(post.statusCode).toBe(302);
      expect(post.headers.location).toBe('/auth/login');
      expect(await passwordHash(email)).toBe(hashBefore);
    });
  });
});
