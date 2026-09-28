import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGarment } from './garments';
import {
  createTestApp,
  TEST_PASSWORD,
  type TestApp,
  uniqueClient,
} from './harness';

/**
 * The metrics (#115): GET /metrics for the homelab's scraper, the devices'
 * timing beacon (POST /metrics/vitals) and Server-Timing. Label values must
 * stay bounded (route templates, never ids), and the beacon is
 * session-only, validated, size-capped and rate-limited.
 */

const METRICS_ENV = { METRICS_ENABLED: 'true' };

/** Every value a label takes in an exposition. */
function labelValues(body: string, label: string): Set<string> {
  const pattern = new RegExp(`[{,]${label}="([^"]*)"`, 'g');
  return new Set([...body.matchAll(pattern)].map((match) => match[1]));
}

function serverTiming(header: unknown): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const entry of String(header).split(',')) {
    const [name, ...params] = entry.trim().split(';');
    const value = params.find((p) => /^(dur|desc)=/.test(p)) ?? '';
    entries[name] = value.replace(/^(dur|desc)=/, '').replace(/"/g, '');
  }
  return entries;
}

describe('metrics, off by default', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  it('has no /metrics and no beacon', async () => {
    expect(
      (await t.inject({ method: 'GET', url: '/metrics' })).statusCode,
    ).toBe(404);
    const beacon = await t.inject({
      method: 'POST',
      url: '/metrics/vitals',
      headers: { 'content-type': 'text/plain' },
      payload: JSON.stringify({ samples: [] }),
    });
    expect(beacon.statusCode).toBe(404);
  });

  it('loads no timing script', async () => {
    const res = await t.inject({ method: 'GET', url: '/wardrobe' });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('/js/vitals.js');
  });

  it('still answers Server-Timing with db, render and the route template', async () => {
    const id = await createGarment(t, { name: 'Oxford shirt' });
    const res = await t.inject({ method: 'GET', url: `/wardrobe/${id}` });
    expect(res.statusCode).toBe(200);
    const timing = serverTiming(res.headers['server-timing']);
    expect(timing.route).toBe('/wardrobe/:id');
    // The session and the garment were read inside this request's timing.
    expect(Number(timing.db)).toBeGreaterThan(0);
    expect(Number(timing.render)).toBeGreaterThan(0);
  });
});

// #136: a request that checked a secret it carries (a password, an access
// or invite token: markSecretChecked) answers without Server-Timing, which
// would give a guesser the server's own time, free of network jitter. No
// route declares it: the check marks its request.
describe('Server-Timing on routes that check a secret', () => {
  let t: TestApp;
  const email = 'timing@example.com';

  beforeAll(async () => {
    t = await createTestApp();
    await t.register(email);
  });

  afterAll(() => t?.cleanup());

  const post = (url: string, payload: Record<string, string>) =>
    t.inject({ method: 'POST', url, payload });

  it.each([
    [
      'sign-in, unknown email',
      () =>
        t.inject({
          method: 'POST',
          url: '/auth/login',
          payload: { email: 'nobody@example.com', password: 'Wrong1234' },
          anonymous: true,
        }),
      401,
    ],
    [
      'sign-in, wrong password',
      () =>
        t.inject({
          method: 'POST',
          url: '/auth/login',
          payload: { email, password: 'Wrong1234' },
          anonymous: true,
        }),
      401,
    ],
    [
      'sign-in, right password',
      () =>
        t.inject({
          method: 'POST',
          url: '/auth/login',
          payload: { email, password: TEST_PASSWORD },
          anonymous: true,
        }),
      302,
    ],
    [
      'change password',
      () =>
        post('/auth/change-password', {
          currentPassword: 'Wrong1234',
          newPassword: 'Another1234',
          confirmPassword: 'Another1234',
        }),
      400,
    ],
    [
      'change email',
      () =>
        post('/auth/update-email', {
          email: 'new@example.com',
          confirmEmail: 'new@example.com',
          currentPassword: 'Wrong1234',
        }),
      400,
    ],
    [
      'delete account',
      () =>
        post('/auth/delete-account', {
          email: 'owner@example.com',
          password: 'Wrong1234',
        }),
      401,
    ],
    [
      'create an access token',
      () =>
        post('/auth/tokens', { name: 'laptop', currentPassword: 'Wrong1234' }),
      400,
    ],
    [
      'invite landing',
      () =>
        t.inject({
          method: 'GET',
          url: '/wardrobe-share/invite/no-such-token',
          anonymous: true,
        }),
      200,
    ],
    [
      'accept an invite',
      () => post('/wardrobe-share/invite/no-such-token/accept', {}),
      302,
    ],
    [
      'decline an invite',
      () => post('/wardrobe-share/invite/no-such-token/decline', {}),
      302,
    ],
    [
      'MCP, unknown token',
      () =>
        t.inject({
          method: 'POST',
          url: '/mcp',
          anonymous: true,
          sameOrigin: false,
          headers: { authorization: 'Bearer closet_pat_unknown' },
          payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        }),
      401,
    ],
  ])('%s answers without it', async (_route, send, status) => {
    const res = await send();
    expect(res.statusCode).toBe(status);
    expect(res.headers['server-timing']).toBeUndefined();
  });

  it.each([
    ['the sign-in page', '/auth/login', true],
    ['the profile', '/auth/profile', false],
    ['the access tokens page', '/auth/tokens', false],
    ['the wardrobe', '/wardrobe', false],
  ])('%s still carries it', async (_page, url, anonymous) => {
    const res = await t.inject({ method: 'GET', url, anonymous });
    expect(res.statusCode).toBe(200);
    expect(serverTiming(res.headers['server-timing']).route).toBe(url);
  });
});

describe('metrics, METRICS_ENABLED=true', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp(METRICS_ENV);
  });

  afterAll(() => t?.cleanup());

  const scrape = async () => {
    const res = await t.inject({
      method: 'GET',
      url: '/metrics',
      anonymous: true,
    });
    expect(res.statusCode).toBe(200);
    return res.body;
  };

  const beacon = (payload: string, cookie?: string) =>
    t.inject({
      method: 'POST',
      url: '/metrics/vitals',
      headers: {
        'content-type': 'text/plain;charset=UTF-8',
        ...(cookie ? { cookie } : {}),
      },
      payload,
    });

  const sample = (overrides: Record<string, unknown> = {}) => ({
    route: '/calendar',
    kind: 'htmx',
    cache: false,
    ms: { request: 120, settle: 35 },
    ...overrides,
  });

  describe('GET /metrics', () => {
    it('serves the exposition to a direct request without a session', async () => {
      const res = await t.inject({
        method: 'GET',
        url: '/metrics',
        anonymous: true,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(
        /^text\/plain; version=0\.0\.4/,
      );
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toContain(
        '# TYPE http_request_duration_seconds histogram',
      );
      expect(res.body).toContain('# TYPE job_duration_seconds histogram');
      expect(res.body).toMatch(/^cutout_queue_depth 0$/m);
      // The process's own, with METRICS_ENABLED.
      expect(res.body).toContain('process_cpu_user_seconds_total');
    });

    it('is a 404 through a reverse proxy', async () => {
      const forwarded = await t.inject({
        method: 'GET',
        url: '/metrics',
        anonymous: true,
        headers: uniqueClient(),
      });
      expect(forwarded.statusCode).toBe(404);
      expect(forwarded.body).not.toContain('http_request_duration_seconds');
      const standard = await t.inject({
        method: 'GET',
        url: '/metrics',
        anonymous: true,
        headers: { forwarded: 'for=203.0.113.9' },
      });
      expect(standard.statusCode).toBe(404);
    });

    it('labels requests by route template, method and status class only', async () => {
      const id = await createGarment(t, { name: 'Linen trousers' });
      await t.inject({ method: 'GET', url: `/wardrobe/${id}` });
      await t.inject({ method: 'GET', url: `/wardrobe/${id}?from=calendar` });
      await t.inject({ method: 'GET', url: `/no-such-page/${id}` });
      const body = await scrape();

      expect(body).toMatch(
        /^http_request_duration_seconds_count\{route="\/wardrobe\/:id",method="GET",status_class="2xx"\} 2$/m,
      );
      expect(body).toMatch(
        /^http_request_duration_seconds_count\{route="unmatched",method="GET",status_class="4xx"\} 1$/m,
      );
      // No raw id, query string or URL anywhere in a label.
      expect(body).not.toContain(`/wardrobe/${id}`);
      expect(body).not.toContain(`/no-such-page/${id}`);
      for (const route of labelValues(body, 'route')) {
        expect(route === 'unmatched' || route.startsWith('/')).toBe(true);
        expect(route).not.toMatch(/\/\d+(\/|$)|\?/);
      }
      for (const statusClass of labelValues(body, 'status_class')) {
        expect(statusClass).toMatch(/^[1-5]xx$/);
      }
      // The scraper sets `job` itself (the homelab contract).
      expect(labelValues(body, 'job').size).toBe(0);
    });

    it('writes no request log line for a scrape', async () => {
      const before = t.logs.records.length;
      await scrape();
      const http = t.logs.records
        .slice(before)
        .filter((record) => record.context === 'Http');
      expect(http).toEqual([]);
    });
  });

  describe('the timing script', () => {
    it('loads on signed-in pages', async () => {
      const res = await t.inject({ method: 'GET', url: '/wardrobe' });
      expect(res.body).toMatch(
        /<script type="module" src="\/js\/vitals\.js\?v=[^"]+"><\/script>/,
      );
    });

    it('does not load signed out (the beacon is session-only)', async () => {
      const res = await t.inject({
        method: 'GET',
        url: '/auth/login',
        anonymous: true,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('/js/vitals.js');
    });
  });

  describe('POST /metrics/vitals', () => {
    it('records a batch into histograms by route, kind, metric and cache', async () => {
      const res = await beacon(
        JSON.stringify({
          samples: [
            sample(),
            sample({
              route: '/styling',
              kind: 'full',
              cache: true,
              ms: { ttfb: 80, lcp: 640, inp: 96 },
            }),
            sample({ route: '/calendar', kind: 'restore', ms: { settle: 12 } }),
          ],
        }),
      );
      expect(res.statusCode).toBe(204);
      const body = await scrape();
      expect(body).toMatch(
        /^client_timing_seconds_count\{route="\/calendar",kind="htmx",metric="request",cache="miss"\} 1$/m,
      );
      expect(body).toMatch(
        /^client_timing_seconds_sum\{route="\/calendar",kind="htmx",metric="settle",cache="miss"\} 0\.035$/m,
      );
      for (const metric of ['ttfb', 'lcp', 'inp']) {
        expect(body).toContain(
          `client_timing_seconds_count{route="/styling",kind="full",metric="${metric}",cache="hit"} 1`,
        );
      }
      expect(body).toContain(
        'client_timing_seconds_count{route="/calendar",kind="restore",metric="settle",cache="miss"} 1',
      );
    });

    it('drops a sample naming no route of the app, keeping the rest', async () => {
      const res = await beacon(
        JSON.stringify({
          samples: [
            sample({ route: '/wardrobe/42' }),
            sample({ route: '/wardrobe' }),
          ],
        }),
      );
      expect(res.statusCode).toBe(204);
      const body = await scrape();
      expect(body).not.toContain('route="/wardrobe/42"');
      expect(body).toMatch(
        /^client_timing_dropped_total\{reason="unknown_route"\} 1$/m,
      );
    });

    it('needs a session', async () => {
      const res = await t.inject({
        method: 'POST',
        url: '/metrics/vitals',
        anonymous: true,
        headers: {
          'content-type': 'text/plain;charset=UTF-8',
          // What sendBeacon sends.
          'sec-fetch-mode': 'no-cors',
        },
        payload: JSON.stringify({ samples: [sample({ route: '/outfits' })] }),
      });
      expect(res.statusCode).toBe(401);
      expect(await scrape()).not.toContain('route="/outfits",kind=');
    });

    it.each([
      ['not JSON', 'samples=1'],
      ['no samples', JSON.stringify({ samples: [] })],
      [
        'an unknown kind',
        JSON.stringify({ samples: [sample({ kind: 'prefetch' })] }),
      ],
      [
        'a value past a minute',
        JSON.stringify({ samples: [sample({ ms: { request: 60_001 } })] }),
      ],
      [
        'a negative value',
        JSON.stringify({ samples: [sample({ ms: { settle: -1 } })] }),
      ],
      [
        'a string for a time',
        JSON.stringify({ samples: [sample({ ms: { lcp: 'slow' } })] }),
      ],
      [
        'more than 20 samples',
        JSON.stringify({ samples: Array.from({ length: 21 }, () => sample()) }),
      ],
    ])('refuses %s with a 400', async (_case, payload) => {
      const res = await beacon(payload);
      expect(res.statusCode).toBe(400);
    });

    it('refuses a body over 8 KB with a 413, before reading it', async () => {
      const res = await beacon(
        JSON.stringify({ samples: [sample({ route: 'x'.repeat(9 * 1024) })] }),
      );
      expect(res.statusCode).toBe(413);
    });

    it('limits each user to 30 batches a minute', async () => {
      // A user of its own: the other tests' batches count for the owner.
      const cookie = await t.register('beacon@example.com');
      const payload = JSON.stringify({ samples: [sample()] });
      for (let i = 0; i < 30; i += 1) {
        expect((await beacon(payload, cookie)).statusCode).toBe(204);
      }
      expect((await beacon(payload, cookie)).statusCode).toBe(429);
      // Per user: the owner is not refused with them.
      expect((await beacon(payload)).statusCode).toBe(204);
    });
  });
});
