import { EntityRepository } from '@mikro-orm/core';
import { getRepositoryToken } from '@mikro-orm/nestjs';
import { AuthContextService } from '../../src/auth/auth-context.service';
import { User } from '../../src/dal/entity/user.entity';
import { createTestApp, TEST_PASSWORD, TestApp } from './harness';

describe('sessions (AUTH_ENABLED=true)', () => {
  let t: TestApp;
  let cookie: string;
  const email = 'alice@example.com';

  beforeAll(async () => {
    t = await createTestApp({ AUTH_ENABLED: 'true' });
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
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/auth/profile');
    const token = res.cookies.find((c) => c.name === 'access_token');
    expect(token?.httpOnly).toBe(true);
    expect(token?.path).toBe('/');
  });

  it.each([
    ['/wardrobe', 302],
    ['/wardrobe-share/manage', 302],
    ['/auth/profile', 401],
  ])('anonymous %s -> %i', async (url, status) => {
    const res = await t.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(status);
    if (status === 302) expect(res.headers.location).toBe('/auth/login');
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
