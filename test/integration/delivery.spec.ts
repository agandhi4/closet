import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGarment } from './garments';
import { createTestApp, PWA_ENV, TestApp, unescapeHtml } from './harness';

/**
 * How the app shell reaches the installed PWA: cache headers on static roots,
 * the heartbeat, versioned asset URLs in the layout, and the wardrobe
 * fragment path that htmx filtering swaps into #wardrobe-main.
 */
describe('delivery (PWA_ENABLED=true)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp(PWA_ENV);
  });

  afterAll(() => t?.cleanup());

  describe('static cache policy', () => {
    it('serves node_modules assets immutable for a year', async () => {
      const res = await t.inject({
        method: 'GET',
        url: '/modules/htmx.min.js',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe(
        'public, max-age=31536000, immutable',
      );
    });

    it('serves public/ files immutable for a year', async () => {
      const res = await t.inject({ method: 'GET', url: '/js/connectivity.js' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe(
        'public, max-age=31536000, immutable',
      );
    });

    it('keeps the service worker revalidating', async () => {
      const res = await t.inject({ method: 'GET', url: '/sw.js' });
      // Built by `npm run generate:sw`; when it is absent the policy is still
      // what matters, and a 404 says nothing about it.
      if (res.statusCode === 200) {
        expect(res.headers['cache-control']).toBe('no-cache');
      } else {
        expect(res.statusCode).toBe(404);
      }
    });

    it('keeps the manifest revalidating', async () => {
      const res = await t.inject({ method: 'GET', url: '/manifest.json' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-cache');
    });

    // The package's ESM build is unminified (modular/sortable.esm.js,
    // 119 KB); the importmap points at the build's minified bundle
    // (views/assets/sortable.js) and the package directory is not served.
    it('serves sortablejs minified and immutable', async () => {
      const res = await t.inject({
        method: 'GET',
        url: '/vendor/sortable.min.js',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/javascript/);
      expect(res.headers['cache-control']).toBe(
        'public, max-age=31536000, immutable',
      );
      expect(res.body).toMatch(/export\s*\{[^}]*\bas default\b/);
      expect(res.rawPayload.byteLength).toBeLessThan(45_000);
      const unminified = await t.inject({
        method: 'GET',
        url: '/modules/modular/sortable.esm.js',
      });
      expect(unminified.statusCode).toBe(404);
    });

    // The server removes backgrounds: the in-browser model, its runtime and
    // its WASM are no longer served.
    it.each([
      '/modules/background-removal/index.mjs',
      '/modules/onnxruntime-web/dist/ort.all.bundle.min.mjs',
      '/bg-removal-models/resources.json',
    ])('no longer serves the in-browser model: %s is a 404', async (url) => {
      expect((await t.inject({ method: 'GET', url })).statusCode).toBe(404);
    });
  });

  describe('GET /healthz', () => {
    it('answers 204, uncacheable, without touching the session', async () => {
      const res = await t.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(204);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toBe('');
      expect(res.headers['set-cookie']).toBeUndefined();
    });
  });

  describe('layout', () => {
    let html: string;

    beforeAll(async () => {
      const res = await t.inject({ method: 'GET', url: '/wardrobe' });
      expect(res.statusCode).toBe(200);
      html = res.body;
    });

    it('versions every first-party script and stylesheet URL', () => {
      const urls = [
        ...html.matchAll(/<script\b[^>]*\ssrc="([^"]+)"/g),
        ...html.matchAll(/<link\b[^>]*\shref="([^"]+)"/g),
      ]
        .map((m) => m[1])
        .filter((url) =>
          /^\/(modules|js|assets)\/|^\/bundle\.css|^\/favicon/.test(url),
        );
      expect(urls.length).toBeGreaterThanOrEqual(6);
      for (const url of urls) {
        expect(url).toMatch(/\?v=[^&"]+$/);
      }
      // Importmap entries are the module graph's URLs; same rule.
      const importmap = /<script type="importmap">([\s\S]*?)<\/script>/.exec(
        html,
      );
      expect(importmap).not.toBeNull();
      const imports = JSON.parse(importmap![1]).imports as Record<
        string,
        string
      >;
      for (const url of Object.values(imports)) {
        expect(url).toMatch(/\?v=[^&"]+$/);
      }
      expect(imports.styling).toMatch(/^\/js\/styling\.js\?v=/);
    });

    // Issue #48: Firefox fetches it as the site icon on every cold load,
    // and iOS shows it at 180 px, so it is never the 1000 px icon.png.
    it('names the 192 px icon as the apple-touch-icon', () => {
      expect(html).toMatch(
        /<link rel="apple-touch-icon" href="\/assets\/icon-192\.png\?v=[^"]+"/,
      );
    });

    it('has one htmx-config meta and no viewport-fit', () => {
      const metas: string[] =
        html.match(/<meta\s+name="htmx-config"[^>]*>/g) ?? [];
      expect(metas).toHaveLength(1);
      const content = /content="([^"]+)"/.exec(metas[0])![1];
      // No view transitions (they drop taps while they run) and a short
      // history cache (layout.tsx says why).
      expect(JSON.parse(unescapeHtml(content))).toEqual({
        disableInheritance: true,
        historyCacheSize: 3,
      });
      expect(html).not.toContain('viewport-fit');
      // Without this, disableInheritance switches hx-boost off for every link
      // and every request loses its tap feedback.
      expect(html).toMatch(
        /<body[^>]*hx-indicator="#loading, closest a"[^>]*hx-inherit="hx-boost hx-indicator"/,
      );
    });

    it('makes no request to another origin', async () => {
      expect(html).not.toContain('preconnect');
      // Every script and link loads from this origin; the canonical link
      // names the page, it loads nothing.
      const tags: string[] = html.match(/<(script|link)\b[^>]*>/g) ?? [];
      const external = tags.filter(
        (tag) =>
          !tag.includes('rel="canonical"') &&
          /\s(src|href)="(https?:)?\/\//.test(tag),
      );
      expect(external).toEqual([]);
      const res = await t.inject({ method: 'GET', url: '/wardrobe' });
      const csp = String(res.headers['content-security-policy']);
      expect(csp).toContain("default-src 'self'");
      expect(csp).not.toMatch(/https?:/);
    });

    it('allows no eval and no blob: scripts, workers or fetches', async () => {
      const res = await t.inject({ method: 'GET', url: '/wardrobe' });
      const directives = new Map(
        String(res.headers['content-security-policy'])
          .split(';')
          .map((directive) => directive.trim().split(/\s+/))
          .filter(([name]) => name)
          .map(([name, ...sources]) => [name, sources]),
      );
      expect(directives.get('script-src')).toEqual([
        "'self'",
        "'unsafe-inline'",
      ]);
      expect(directives.get('worker-src')).toEqual(["'self'"]);
      expect(directives.get('connect-src')).toEqual(["'self'"]);
      // The mask editor draws from object URLs.
      expect(directives.get('img-src')).toContain('blob:');
    });

    it('loads page-only libraries on their pages, not in the shell', () => {
      // pwa.js imports the install dialog and pull to refresh only where
      // they apply; the element is never in the markup.
      expect(html).toContain('/js/pwa.js?v=');
      expect(html).not.toContain('src="/modules/pwa-install');
      expect(html).not.toContain('<pwa-install');
      // Styling's module is only mapped here; its page imports it.
      expect(html).not.toMatch(/<script\b[^>]*\ssrc="[^"]*styling/i);
      expect(html).not.toMatch(/onnxruntime|background-removal/);
      expect(html).not.toContain('rel="preload"');
      expect(html).toContain('id="request-indicator"');
      expect(html).not.toContain('offline-indicator');
      expect(html).toContain('id="connectivity-banner"');
    });
  });

  describe('GET /wardrobe fragment', () => {
    beforeAll(async () => {
      await createGarment(t, { name: 'Fragment shirt' });
    });

    it('returns only #wardrobe-main to an htmx request', async () => {
      const res = await t.inject({
        method: 'GET',
        url: '/wardrobe?keyword=Fragment',
        headers: { 'hx-request': 'true' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers.vary).toContain('HX-Request');
      expect(res.body).not.toContain('<html');
      expect(res.body).not.toContain('<nav');
      expect(res.body.trimStart()).toMatch(/^<main id="wardrobe-main"/);
      expect(res.body).toContain('Fragment shirt');
      expect(res.body).toContain('id="filter-modal"');
    });

    it('returns the full page to a boosted request', async () => {
      const res = await t.inject({
        method: 'GET',
        url: '/wardrobe',
        headers: { 'hx-request': 'true', 'hx-boosted': 'true' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers.vary).toContain('HX-Boosted');
      expect(res.body).toContain('<html');
      expect(res.body).toContain('id="wardrobe-main"');
    });

    it('renders the same partial inside the full page', async () => {
      const res = await t.inject({ method: 'GET', url: '/wardrobe' });
      expect(res.body).toContain('id="wardrobe-main"');
      expect(res.body).toMatch(
        /<form[^>]*hx-get="\/wardrobe"[^>]*hx-target="#wardrobe-main"/,
      );
    });
  });

  // What the service worker's page cache relies on (src/web/page-cache.ts).
  describe('the page cache contract', () => {
    it('names the account on every HTML answer of a session', async () => {
      const page = await t.inject({ method: 'GET', url: '/outfits' });
      expect(page.headers['x-page-account']).toBe(String(t.owner.id));
      const fragment = await t.inject({
        method: 'GET',
        url: '/wardrobe?keyword=x',
        headers: { 'hx-request': 'true' },
      });
      expect(fragment.headers['x-page-account']).toBe(String(t.owner.id));

      const other = await t.register('page-cache-other@example.com');
      const theirs = await t.inject({
        method: 'GET',
        url: '/outfits',
        headers: { cookie: other },
      });
      expect(theirs.headers['x-page-account']).not.toBe(String(t.owner.id));
      expect(theirs.headers['x-page-account']).toMatch(/^\d+$/);
    });

    it('names no account on a signed-out render', async () => {
      const res = await t.inject({
        method: 'GET',
        url: '/auth/login',
        anonymous: true,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-page-account']).toBeUndefined();
    });

    // The worker tells "changed" from "the same" by comparing bodies, so a
    // tab root must render byte for byte the same while nothing changes.
    it.each(['/wardrobe', '/styling', '/outfits', '/calendar'])(
      'renders %s identically twice',
      async (url) => {
        const first = await t.inject({ method: 'GET', url });
        const second = await t.inject({ method: 'GET', url });
        expect(first.statusCode).toBe(200);
        expect(second.body).toBe(first.body);
      },
    );

    it('renders the freshness indicator hidden, with its strings', async () => {
      const res = await t.inject({ method: 'GET', url: '/wardrobe' });
      expect(res.body).toMatch(/<span id="freshness" class="hidden[^"]*"/);
      expect(res.body).toContain('data-text-updated-ago="Updated {ago}"');
      const importmap = /<script type="importmap">([\s\S]*?)<\/script>/.exec(
        res.body,
      );
      const imports = JSON.parse(importmap![1]).imports as Record<
        string,
        string
      >;
      expect(imports.freshness).toMatch(/^\/js\/freshness\.js\?v=/);
      expect(imports['age-label']).toMatch(/^\/js\/age-label\.js\?v=/);
    });
  });
});
