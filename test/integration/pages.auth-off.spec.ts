import { randomUUID } from 'node:crypto';
import { createTestApp, TestApp } from './harness';
import {
  createPageFixture,
  expectFragment,
  expectFullPage,
  HX_BOOSTED,
  HX_FRAGMENT,
  PageFixture,
  pageRoutes,
} from './pages';

/**
 * Every GET page renders with AUTH_ENABLED=false: the documented status, a
 * whole document with one htmx-config meta and no untranslated `lang.` key,
 * the full page again for boosted navigations, and bare fragments for the
 * routes htmx swaps into a page. The signed-in twin is pages.auth-on.spec.ts.
 */
describe('pages (AUTH_ENABLED=false)', () => {
  let t: TestApp;
  let fixture: PageFixture;

  beforeAll(async () => {
    t = await createTestApp();
    fixture = await createPageFixture(t);
  });

  afterAll(() => t?.cleanup());

  // A getter: the table needs the fixture, which only exists after beforeAll.
  const routes = () => pageRoutes(fixture, randomUUID());

  it('renders every page route with its documented status', async () => {
    for (const { url, authOff } of routes()) {
      const res = await t.inject({ method: 'GET', url });
      expect({ url, status: res.statusCode }).toEqual({ url, status: authOff });
      expectFullPage(res);
    }
  });

  it('answers boosted navigations with the full page', async () => {
    for (const { url, authOff } of routes()) {
      const res = await t.inject({ method: 'GET', url, headers: HX_BOOSTED });
      expect({ url, status: res.statusCode }).toEqual({ url, status: authOff });
      expectFullPage(res);
    }
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

  it('GET /.well-known/* answers without rendering a page', async () => {
    const res = await t.inject({
      method: 'GET',
      url: '/.well-known/assetlinks.json',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
  });

  it('an unknown garment renders the error page', async () => {
    const res = await t.inject({ method: 'GET', url: '/wardrobe/999999' });
    expect(res.statusCode).toBe(404);
    expectFullPage(res);
  });
});
