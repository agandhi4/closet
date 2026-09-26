import { EntityRepository } from '@mikro-orm/core';
import { getRepositoryToken } from '@mikro-orm/nestjs';
import { AuthContextService } from '../../src/auth/auth-context.service';
import { User } from '../../src/dal/entity/user.entity';
import { Logger as PinoLogger } from 'nestjs-pino';
import { createTestApp, TEST_PASSWORD, TestApp } from './harness';

describe('sessions', () => {
  let t: TestApp;
  let cookie: string;
  const email = 'alice@example.com';

  beforeAll(async () => {
    t = await createTestApp();
    cookie = await t.register(email);
  });

  afterAll(() => t?.cleanup());

  it('register sets an httpOnly session cookie and lands on the profile', async () => {
    const res = await t.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'bob@example.com',
        password: TEST_PASSWORD,
        confirmPassword: TEST_PASSWORD,
      },
      anonymous: true,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/auth/profile');
    const token = res.cookies.find((c) => c.name === 'access_token');
    expect(token?.httpOnly).toBe(true);
    expect(token?.path).toBe('/');
  });

  // SessionGuard, the one global gate. Its three outcomes: public routes
  // answer anyone, a page navigation without a session is redirected, and an
  // htmx fragment or fetch gets a 401 whose HX-Redirect htmx follows.
  describe('login required (SessionGuard)', () => {
    it.each([
      ['/auth/login', 200],
      ['/auth/register', 200],
      ['/about', 200],
      ['/offline.html', 200],
      ['/healthz', 204],
      ['/manifest.json', 200],
      ['/share?shareableId=nothing&type=garment', 200],
    ])('public %s answers an anonymous visitor (%i)', async (url, status) => {
      const res = await t.inject({ method: 'GET', url, anonymous: true });
      expect(res.statusCode).toBe(status);
      expect(res.headers.location).toBeUndefined();
    });

    it.each([
      '/',
      '/wardrobe',
      '/outfits',
      '/calendar',
      '/wardrobe-share/manage',
      '/auth/profile',
      '/auth/update-email',
      '/auth/delete-account',
    ])('anonymous navigation to %s -> 302 /auth/login', async (url) => {
      for (const headers of [
        {},
        { 'sec-fetch-mode': 'navigate' },
        { 'hx-request': 'true', 'hx-boosted': 'true' },
      ]) {
        const res = await t.inject({
          method: 'GET',
          url,
          headers,
          anonymous: true,
        });
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe('/auth/login');
      }
    });

    it.each([
      ['htmx fragment', 'GET', '/wardrobe', { 'hx-request': 'true' }],
      [
        'htmx form post',
        'POST',
        '/calendar/1/worn',
        { 'hx-request': 'true', 'sec-fetch-mode': 'cors' },
      ],
      [
        'fetch',
        'POST',
        '/notification/subscribe',
        { 'sec-fetch-mode': 'cors' },
      ],
      [
        'same-origin fetch',
        'POST',
        '/wardrobe/1/nobg',
        { 'sec-fetch-mode': 'same-origin' },
      ],
    ] as const)(
      'anonymous %s (%s %s) -> 401 with HX-Redirect',
      async (_label, method, url, headers) => {
        const res = await t.inject({ method, url, headers, anonymous: true });
        expect(res.statusCode).toBe(401);
        expect(res.headers['hx-redirect']).toBe('/auth/login');
        expect(res.headers.location).toBeUndefined();
        expect(res.body).toBe('');
      },
    );
  });

  it('a logged-out page hit redirects without warn or error log lines', async () => {
    // Nest's Logger delegates to the nestjs-pino instance registered by
    // app.useLogger (app.ts), so a spy there sees every warn the guards and
    // ErrorViewFilter could emit for this request.
    const logger = t.app.get(PinoLogger);
    const warn = jest.spyOn(logger, 'warn');
    const error = jest.spyOn(logger, 'error');
    try {
      const res = await t.inject({
        method: 'GET',
        url: '/wardrobe',
        anonymous: true,
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/auth/login');
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('a session cookie opens the wardrobe and the profile', async () => {
    const wardrobe = await t.inject({
      method: 'GET',
      url: '/wardrobe',
      headers: { cookie },
    });
    expect(wardrobe.statusCode).toBe(200);

    const profile = await t.inject({
      method: 'GET',
      url: '/auth/profile',
      headers: { cookie },
    });
    expect(profile.statusCode).toBe(200);
    expect(profile.body).toContain(email);
  });

  it('a garbage cookie is an anonymous request', async () => {
    const res = await t.inject({
      method: 'GET',
      url: '/wardrobe',
      headers: { cookie: 'access_token=not-a-jwt' },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/auth/login');
  });

  it('login issues a session only for the right password', async () => {
    const fresh = await t.login(email);
    const res = await t.inject({
      method: 'GET',
      url: '/auth/profile',
      headers: { cookie: fresh },
    });
    expect(res.statusCode).toBe(200);

    const wrong = await t.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'WrongPassword1' },
      anonymous: true,
    });
    // Re-rendered login form (Nest's POST default is 201; see report).
    expect(wrong.statusCode).toBeLessThan(300);
    expect(wrong.body).toContain('/auth/login');
    expect(
      wrong.cookies.find((c) => c.name === 'access_token'),
    ).toBeUndefined();
  });

  it('a wardrobe you have no share for is forbidden', async () => {
    const res = await t.inject({
      method: 'GET',
      url: '/wardrobe?ownerId=999',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('static assets are served without resolving the session', async () => {
    const resolve = jest.spyOn(t.app.get(AuthContextService), 'resolve');
    const findOne = jest.spyOn(
      t.app.get<EntityRepository<User>>(getRepositoryToken(User)),
      'findOne',
    );

    const asset = await t.inject({
      method: 'GET',
      url: '/robots.txt',
      headers: { cookie },
    });
    expect(asset.statusCode).toBe(200);
    expect(resolve).not.toHaveBeenCalled();
    expect(findOne).not.toHaveBeenCalled();

    // Same cookie on a page: exactly one session resolution, one user load.
    await t.inject({ method: 'GET', url: '/wardrobe', headers: { cookie } });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(findOne).toHaveBeenCalledTimes(1);

    resolve.mockRestore();
    findOne.mockRestore();
  });
});
