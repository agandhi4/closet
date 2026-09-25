import { createTestApp, TestApp } from './harness';
import {
  createPageFixture,
  expectFragment,
  expectFullPage,
  HX_BOOSTED,
  HX_FRAGMENT,
  PageFixture,
  PageRoute,
  pageRoutes,
} from './pages';

/**
 * Every GET page renders with AUTH_ENABLED=true for a signed-in user (the
 * production configuration), with the same checks as pages.auth-off.spec.ts,
 * plus what an anonymous visitor gets: the public pages, and a login
 * redirect (or AuthGuard's 401) for everything else.
 */
describe('pages (AUTH_ENABLED=true)', () => {
  let t: TestApp;
  let cookie: string;
  let fixture: PageFixture;
  let inviteToken: string;

  beforeAll(async () => {
    t = await createTestApp({ AUTH_ENABLED: 'true' });
    cookie = await t.register('alice@example.com');
    fixture = await createPageFixture(t, cookie);

    const invite = await t.inject({
      method: 'POST',
      url: '/wardrobe-share/create-invite-link',
      payload: { permission: 'VIEW' },
      headers: { cookie, ...HX_FRAGMENT },
    });
    expect(invite.statusCode).toBeLessThan(300);
    expectFragment(invite);
    const match = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(invite.body);
    if (!match) throw new Error(`No invite URL in partial:\n${invite.body}`);
    inviteToken = match[1];
  });

  afterAll(() => t?.cleanup());

  const routes = (): PageRoute[] => pageRoutes(fixture, inviteToken);

  it('renders every page route for a signed-in user', async () => {
    for (const { url, authOn } of routes()) {
      const res = await t.inject({ method: 'GET', url, headers: { cookie } });
      expect({ url, status: res.statusCode }).toEqual({ url, status: authOn });
      expectFullPage(res);
    }
  });

  it('answers boosted navigations with the full page', async () => {
    for (const { url, authOn } of routes()) {
      const res = await t.inject({
        method: 'GET',
        url,
        headers: { cookie, ...HX_BOOSTED },
      });
      expect({ url, status: res.statusCode }).toEqual({ url, status: authOn });
      expectFullPage(res);
    }
  });

  it('the profile and invite pages show the signed-in account', async () => {
    const profile = await t.inject({
      method: 'GET',
      url: '/auth/profile',
      headers: { cookie },
    });
    expect(profile.body).toContain('alice@example.com');

    const invite = await t.inject({
      method: 'GET',
      url: `/wardrobe-share/invite/${inviteToken}`,
    });
    expect(invite.statusCode).toBe(200);
    expectFullPage(invite);
    expect(invite.body).toContain('alice@example.com');
  });

  it('GET /wardrobe as an htmx fragment is only #wardrobe-main', async () => {
    const res = await t.inject({
      method: 'GET',
      url: '/wardrobe?keyword=Blazer',
      headers: { cookie, ...HX_FRAGMENT },
    });
    expect(res.statusCode).toBe(200);
    expectFragment(res);
    expect(res.headers.vary).toContain('HX-Request');
    expect(res.body).toContain('Black Linen Blazer');
    expect(res.body).not.toContain('drawer navbar');
  });

  it('GET /outfits/row-fragment is a bare outfit row', async () => {
    const res = await t.inject({
      method: 'GET',
      url: '/outfits/row-fragment?category=shirt&index=1',
      headers: { cookie, ...HX_FRAGMENT },
    });
    expect(res.statusCode).toBe(200);
    expectFragment(res);
  });

  it.each([
    '/auth/login',
    '/auth/register',
    '/auth/reset',
    '/auth/reset-code',
    '/about',
    '/offline.html',
  ])('anonymous %s renders', async (url) => {
    const res = await t.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    expectFullPage(res);
  });

  it('anonymous visitors see public share and invite pages', async () => {
    for (const url of [
      `/share?shareableId=${fixture.garmentShareableId}&type=garment`,
      `/wardrobe-share/invite/${inviteToken}`,
    ]) {
      const res = await t.inject({ method: 'GET', url });
      expect({ url, status: res.statusCode }).toEqual({ url, status: 200 });
      expectFullPage(res);
    }
  });

  it('anonymous visitors are sent to login from every app page', async () => {
    const protectedPages = routes().filter(
      ({ url }) =>
        /^\/(wardrobe|outfits|calendar)\b/.test(url) &&
        !url.startsWith('/wardrobe-share/invite/'),
    );
    expect(protectedPages.length).toBeGreaterThan(10);
    for (const { url } of protectedPages) {
      const res = await t.inject({ method: 'GET', url });
      expect({
        url,
        status: res.statusCode,
        location: res.headers.location,
      }).toEqual({ url, status: 302, location: '/auth/login' });
    }
  });

  it.each(['/auth/profile', '/auth/update-email', '/auth/delete-account'])(
    'anonymous %s is 401 (AuthGuard)',
    async (url) => {
      const res = await t.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
      expectFullPage(res);
    },
  );
});
