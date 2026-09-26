import type { LightMyRequestResponse } from 'fastify';
import { User } from '../../src/dal/entity/user.entity';
import { EmailService } from '../../src/email/email.service';
import { createTestApp, TEST_PASSWORD, TestApp } from './harness';

/**
 * Account flows, end to end through the real
 * controllers: inline registration validation, logout, changing the email,
 * the delete-account page, login failures, and the whole password reset
 * (EmailService stubbed at its one public method, the PIN read from the
 * password_reset row). Sessions are asserted through the `pwf` password
 * fingerprint AuthContextService checks on every request.
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
  let sendEmail: jest.SpyInstance;

  // Each login-driven test gets its own client address (TRUSTED_PROXIES
  // trusts X-Forwarded-For from inject's 127.0.0.1), so no test's attempts
  // count towards another's rate limit.
  let clientSeq = 0;
  const nextClient = () => ({ 'x-forwarded-for': `10.0.0.${++clientSeq}` });

  const postLogin = (email: string, password: string, client = nextClient()) =>
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
    // No EMAIL_TRANSPORT in tests, so the real transporter does not exist.
    // AuthService holds this same singleton, so the spy sees every reset mail.
    sendEmail = jest
      .spyOn(t.app.get(EmailService), 'sendEmailFromPrimaryAddress')
      .mockResolvedValue('<test-message-id>');
  });

  beforeEach(() => sendEmail.mockClear());

  afterAll(async () => {
    sendEmail?.mockRestore();
    await t?.cleanup();
  });

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
      expect(res.body).toContain('value="not-an-email"');
      expect(res.body).not.toMatch(/\blang\.(validation\.)?[A-Z_]{3,}/);
      expect(res.body).toMatch(/btn-disabled/);
    });

    it('a valid body has no errors and an enabled submit', async () => {
      const res = await validate({
        email: 'valid@example.com',
        password: TEST_PASSWORD,
        confirmPassword: TEST_PASSWORD,
      });
      expect(res.statusCode).toBeLessThan(300);
      expect(res.body).not.toContain('class="text-error"');
      expect(res.body).not.toContain('btn-disabled');
      expect(await t.em().count(User, { email: 'valid@example.com' })).toBe(0);
    });

    // New bug: the fieldset in views/auth/register.hbs posts here with the
    // default innerHTML swap and no hx-select, but @Render('auth/register')
    // wraps the answer in the layout, so htmx nests a second navbar, form and
    // dock inside the fieldset. Same for validate/update-email and
    // validate/reset-code.
    it.failing(
      'answers the htmx validation request with a fragment',
      async () => {
        const res = await validate({
          email: 'not-an-email',
          password: 'short',
          confirmPassword: 'different',
        });
        expect(res.body).not.toMatch(/<html\b/i);
      },
    );
  });

  describe('login', () => {
    const email = 'login@example.com';

    beforeAll(() => t.register(email));

    it('a wrong password re-renders the form without a session', async () => {
      const res = await postLogin(email, 'WrongPassword1');
      expect(res.body).toContain('hx-post="/auth/login"');
      expect(sessionCookie(res)).toBeUndefined();
    });

    // Known bug (docs/audits/2026-09-25-program2): a failed POST /auth/login re-renders with status 201 instead of 4xx.
    it.failing('a wrong password answers 401', async () => {
      const res = await postLogin(email, 'WrongPassword1');
      expect(res.statusCode).toBe(401);
    });

    // Known bug (docs/audits/2026-09-25-program2): the access_token maxAge is milliseconds, @fastify/cookie takes seconds (Max-Age=31536000000).
    it.failing('the session cookie lives 365 days', async () => {
      const res = await postLogin(email, TEST_PASSWORD);
      expect(res.statusCode).toBe(302);
      expect(sessionSetCookie(res)).toMatch(/;\s*Max-Age=31536000(;|$)/);
    });

    // New bug: ThrottlerModule.forRoot() registers no named throttler, and
    // @Throttle({ default: ... }) only overrides the limits of a registered
    // one, so the guard iterates an empty list: login (and the reset-code
    // validation) is not rate limited at all.
    it.failing(
      'a sixth failed login within a minute is throttled',
      async () => {
        const client = nextClient();
        const statuses: number[] = [];
        for (let i = 0; i < 6; i++) {
          statuses.push(
            (await postLogin(email, 'WrongPassword1', client)).statusCode,
          );
        }
        expect(statuses[5]).toBe(429);
      },
    );
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
      expect(res.body).toContain('hx-post="/auth/update-email"');
      expect(res.body).toContain('name="confirmEmail"');
    });

    it('POST /auth/validate/update-email flags a mismatched confirmation', async () => {
      const bad = await t.inject({
        method: 'POST',
        url: '/auth/validate/update-email',
        payload: { email: newEmail, confirmEmail: 'other@example.com' },
        headers: { cookie, 'hx-request': 'true' },
      });
      expect(bad.statusCode).toBeLessThan(300);
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

    it('a mismatched submission re-renders and changes nothing', async () => {
      const res = await t.inject({
        method: 'POST',
        url: '/auth/update-email',
        payload: { email: newEmail, confirmEmail: 'other@example.com' },
        headers: { cookie },
      });
      expect(res.statusCode).toBeLessThan(300);
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

    // New bug: user.email is @Unique and changeEmail does not check for an
    // existing account first, so the unique violation escapes as a 500.
    it.failing(
      'an address another account uses is refused with 4xx',
      async () => {
        await t.register('taken@example.com');
        const res = await t.inject({
          method: 'POST',
          url: '/auth/update-email',
          payload: {
            email: 'taken@example.com',
            confirmEmail: 'taken@example.com',
          },
          headers: { cookie },
        });
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        expect(res.statusCode).toBeLessThan(500);
      },
    );
  });

  it('GET /auth/delete-account renders the confirmation form', async () => {
    const cookie = await t.register('leaving@example.com');
    const res = await t.inject({
      method: 'GET',
      url: '/auth/delete-account',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('hx-post="/auth/delete-account"');
    expect(await t.em().count(User, { email: 'leaving@example.com' })).toBe(1);
  });

  describe('password reset', () => {
    const email = 'forgetful@example.com';
    let oldSession: string;

    const requestReset = (address: string) =>
      t.inject({
        method: 'POST',
        url: '/auth/reset',
        payload: { email: address },
      });

    const submitCode = (resetCode: string, password: string) =>
      t.inject({
        method: 'POST',
        url: '/auth/reset-code',
        payload: { email, resetCode, password, confirmPassword: password },
      });

    const storedPin = async (address: string) => {
      const user = await t
        .em()
        .findOneOrFail(
          User,
          { email: address },
          { populate: ['passwordReset'] },
        );
      // Typed as always set, but null until the first reset request.
      const pin = (
        user.passwordReset as typeof user.passwordReset | null
      )?.unwrap().pin;
      if (!pin) throw new Error(`No password_reset row for ${address}`);
      return pin;
    };

    beforeAll(async () => {
      oldSession = await t.register(email);
    });

    it('an unknown address re-renders the form and sends nothing', async () => {
      const res = await requestReset('nobody@example.com');
      expect(res.statusCode).toBeLessThan(300);
      expect(res.body).toContain('hx-post="/auth/reset"');
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it('POST /auth/validate/reset-code flags mismatched passwords', async () => {
      const res = await t.inject({
        method: 'POST',
        url: '/auth/validate/reset-code',
        payload: {
          email,
          resetCode: '123456',
          password: NEW_PASSWORD,
          confirmPassword: 'Different123',
        },
        headers: { 'hx-request': 'true' },
      });
      expect(res.statusCode).toBeLessThan(300);
      expect(res.body).toContain('class="text-error"');
      expect(res.body).not.toMatch(/\blang\.(validation\.)?[A-Z_]{3,}/);
    });

    it('resets the password with the mailed PIN and ends every old session', async () => {
      const res = await requestReset(email);
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(`/auth/reset-code?email=${email}`);

      expect(sendEmail).toHaveBeenCalledTimes(1);
      const mail = sendEmail.mock.calls[0][0] as { to: string; html: string };
      expect(mail.to).toBe(email);
      const pin = await storedPin(email);
      expect(pin).toMatch(/^\d{6}$/);
      expect(mail.html).toContain(pin);

      const hashBefore = await passwordHash(email);
      const done = await submitCode(pin, NEW_PASSWORD);
      expect(done.statusCode).toBe(302);
      expect(done.headers.location).toBe('/auth/login');
      expect(await passwordHash(email)).not.toBe(hashBefore);

      // The old token's pwf no longer matches the stored hash.
      expect(await profileStatus(oldSession)).toBe(302);
      expect(
        sessionCookie(await postLogin(email, TEST_PASSWORD)),
      ).toBeUndefined();
      const fresh = sessionCookie(await postLogin(email, NEW_PASSWORD));
      expect(fresh).toBeDefined();
      expect(await profileStatus(fresh!)).toBe(200);
    });

    it('a wrong PIN leaves the password alone', async () => {
      await requestReset(email);
      const pin = await storedPin(email);
      const wrong = pin === '100000' ? '100001' : '100000';
      const hashBefore = await passwordHash(email);
      await submitCode(wrong, 'Attacker789!');
      expect(await passwordHash(email)).toBe(hashBefore);
    });

    // New bug: AuthService.resetPassword ignores a PIN mismatch and the
    // controller redirects to /auth/login as if the reset worked; the user
    // gets no error and their "new" password never works.
    it.failing(
      'a wrong PIN is reported instead of redirecting to login',
      async () => {
        await requestReset(email);
        const pin = await storedPin(email);
        const wrong = pin === '100000' ? '100001' : '100000';
        const res = await submitCode(wrong, 'Attacker789!');
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        expect(res.headers.location).toBeUndefined();
      },
    );

    // Known bug (docs/audits/2026-09-25-program2): the reset PIN never expires and is not single-use.
    it.failing('a PIN works only once', async () => {
      await requestReset(email);
      const pin = await storedPin(email);
      await submitCode(pin, 'FirstReset111!');
      const afterFirst = await passwordHash(email);

      await submitCode(pin, 'SecondReset222!');
      expect(await passwordHash(email)).toBe(afterFirst);
    });
  });
});
