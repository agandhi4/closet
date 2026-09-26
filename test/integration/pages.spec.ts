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
 * Every GET page renders for the signed-in default user: status 200, a whole
 * document with one htmx-config meta and no untranslated `lang.` key, the
 * full page again for boosted navigations, and bare fragments for the routes
 * htmx swaps into a page. Plus what an anonymous visitor gets: the @Public()
 * pages, and a login redirect for everything else.
 */
describe('pages', () => {
  let t: TestApp;
  let fixture: PageFixture;
  let inviteToken: string;

  beforeAll(async () => {
    t = await createTestApp();
    fixture = await createPageFixture(t);

    const invite = await t.inject({
      method: 'POST',
      url: '/wardrobe-share/create-invite-link',
      payload: { permission: 'VIEW' },
      headers: HX_FRAGMENT,
    });
    expect(invite.statusCode).toBeLessThan(300);
    expectFragment(invite);
    const match = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(invite.body);
    if (!match) throw new Error(`No invite URL in partial:\n${invite.body}`);
    inviteToken = match[1];
  });

  afterAll(() => t?.cleanup());

  // A getter: the table needs the fixture, which only exists after beforeAll.
  const routes = (): PageRoute[] => pageRoutes(fixture, inviteToken);

  it('renders every page route for a signed-in user', async () => {
    for (const { url } of routes()) {
      const res = await t.inject({ method: 'GET', url });
      expect({ url, status: res.statusCode }).toEqual({ url, status: 200 });
      expectFullPage(res);
    }
  });

  it('answers boosted navigations with the full page', async () => {
    for (const { url } of routes()) {
      const res = await t.inject({ method: 'GET', url, headers: HX_BOOSTED });
      expect({ url, status: res.statusCode }).toEqual({ url, status: 200 });
      expectFullPage(res);
    }
  });

  it('the profile and invite pages show the signed-in account', async () => {
    const profile = await t.inject({ method: 'GET', url: '/auth/profile' });
    expect(profile.body).toContain(t.owner.email);

    const invite = await t.inject({
      method: 'GET',
      url: `/wardrobe-share/invite/${inviteToken}`,
      anonymous: true,
    });
    expect(invite.statusCode).toBe(200);
    expectFullPage(invite);
    expect(invite.body).toContain(t.owner.email);
  });

  it('GET /wardrobe as an htmx fragment is only #wardrobe-main', async () => {
    const res = await t.inject({
      method: 'GET',
      url: '/wardrobe?keyword=Blazer',
      headers: HX_FRAGMENT,
    });
    expect(res.statusCode).toBe(200);
    expectFragment(res);
    expect(res.headers.vary).toContain('HX-Request');
    expect(res.body).toContain('Black Linen Blazer');
    expect(res.body).not.toContain('drawer navbar');
    expect(res.body).not.toContain("class='dock'");
  });

  it('GET /outfits/row-fragment is a bare outfit row', async () => {
    const res = await t.inject({
      method: 'GET',
      url: '/outfits/row-fragment?category=shirt&index=1',
      headers: HX_FRAGMENT,
    });
    expect(res.statusCode).toBe(200);
    expectFragment(res);
  });

  it('GET /.well-known/* answers anyone without rendering a page', async () => {
    const res = await t.inject({
      method: 'GET',
      url: '/.well-known/assetlinks.json',
      anonymous: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
  });

  it('an unknown garment renders the error page', async () => {
    const res = await t.inject({ method: 'GET', url: '/wardrobe/999999' });
    expect(res.statusCode).toBe(404);
    expectFullPage(res);
  });

  it('anonymous visitors see every public page', async () => {
    const publicPages = routes().filter((route) => route.public);
    for (const { url } of publicPages) {
      const res = await t.inject({ method: 'GET', url, anonymous: true });
      expect({ url, status: res.statusCode }).toEqual({ url, status: 200 });
      expectFullPage(res);
    }
  });

  it('anonymous visitors are sent to login from every other page', async () => {
    const protectedPages = routes().filter((route) => !route.public);
    expect(protectedPages.length).toBeGreaterThan(10);
    for (const { url } of protectedPages) {
      const res = await t.inject({ method: 'GET', url, anonymous: true });
      expect({
        url,
        status: res.statusCode,
        location: res.headers.location,
      }).toEqual({ url, status: 302, location: '/auth/login' });
    }
  });
});
