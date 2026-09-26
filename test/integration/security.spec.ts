import { count, eq } from 'drizzle-orm';
import { Logger as PinoLogger } from 'nestjs-pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { garment, outfitCalendar, user } from '../../src/db/schema';
import { createGarment } from './garments';
import { APP_ORIGIN, createTestApp, TestApp } from './harness';

/**
 * Cross-cutting request security: the same-origin (CSRF) check on every
 * state-changing route, Nest's and the web layer's; `returnTo` values;
 * what logout tells the browser; and invite tokens staying out of the logs.
 */
describe('request security', () => {
  let t: TestApp;
  let outfitId: number;

  const rows = async (table: typeof garment | typeof outfitCalendar) =>
    (await t.db.select({ n: count() }).from(table))[0].n;

  beforeAll(async () => {
    t = await createTestApp();
    // The outfit form only renders its fields (and the posted-back
    // returnTo) once there is a garment to pick.
    await createGarment(t, { name: 'Plain tee' });
    const created = await t.inject({
      method: 'POST',
      url: '/outfits',
      payload: { name: 'Scheduled look' },
    });
    outfitId = Number(/\d+$/.exec(created.headers.location as string)![0]);
  });

  afterAll(() => t?.cleanup());

  describe('same-origin check (CSRF)', () => {
    // POST /wardrobe is a Nest route, POST /calendar a web-layer one.
    const createGarmentFrom = (headers: Record<string, string>) =>
      t.inject({
        method: 'POST',
        url: '/wardrobe',
        payload: { name: 'Planted garment', category: 'shirt' },
        headers,
        sameOrigin: false,
      });
    const schedule = (headers: Record<string, string>) =>
      t.inject({
        method: 'POST',
        url: '/calendar',
        payload: { date: '2026-09-21', outfitId: String(outfitId) },
        headers,
        sameOrigin: false,
      });

    it.each([
      ['another site in Origin', { origin: 'https://evil.test' }],
      ['another site in Referer', { referer: 'https://evil.test/page' }],
      ['an opaque Origin', { origin: 'null' }],
      ['neither Origin nor Referer', {}],
      // Same host, other scheme: a different origin.
      ['this host over another scheme', { origin: 'https://localhost' }],
    ])('refuses %s with 403, before any write', async (_label, headers) => {
      const garmentsBefore = await rows(garment);
      const nest = await createGarmentFrom(headers);
      expect(nest.statusCode).toBe(403);
      expect(await rows(garment)).toBe(garmentsBefore);

      const entriesBefore = await rows(outfitCalendar);
      const web = await schedule(headers);
      expect(web.statusCode).toBe(403);
      expect(await rows(outfitCalendar)).toBe(entriesBefore);
    });

    it('refuses a cross-site login, and an email change without a password', async () => {
      const login = await t.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: t.owner.email, password: 'whatever' },
        headers: { origin: 'https://evil.test' },
        anonymous: true,
        sameOrigin: false,
      });
      expect(login.statusCode).toBe(403);
      expect(login.cookies).toHaveLength(0);

      const change = await t.inject({
        method: 'POST',
        url: '/auth/update-email',
        payload: {
          email: 'hijacked@evil.test',
          confirmEmail: 'hijacked@evil.test',
        },
        headers: { origin: 'https://evil.test' },
        sameOrigin: false,
      });
      expect(change.statusCode).toBe(403);
      const [owner] = await t.db
        .select({ email: user.email })
        .from(user)
        .where(eq(user.id, t.owner.id));
      expect(owner.email).toBe(t.owner.email);
    });

    it.each([
      ['its own origin', { origin: APP_ORIGIN }],
      [
        'its own origin with the default port',
        { origin: 'http://localhost:80' },
      ],
      ["SITE_URL's origin", { origin: 'http://localhost:3000' }],
      [
        'a same-origin Referer without Origin',
        { referer: `${APP_ORIGIN}/outfits/new` },
      ],
    ])('accepts %s', async (_label, headers) => {
      const res = await createGarmentFrom(headers);
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toMatch(/^\/wardrobe\/\d+/);
      expect((await schedule(headers)).statusCode).toBe(302);
    });

    it('believes forwarded scheme and host only from a trusted proxy', async () => {
      // inject() comes from 127.0.0.1, which TRUSTED_PROXIES lists here: the
      // request's own origin is then what the proxy says it was sent to.
      const res = await createGarmentFrom({
        origin: 'https://closet.example',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'closet.example',
      });
      expect(res.statusCode).toBe(302);
    });

    it('never checks a safe method', async () => {
      const res = await t.inject({
        method: 'GET',
        url: '/outfits',
        headers: { origin: 'https://evil.test' },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('returnTo on the outfit form', () => {
    it.each([
      "javascript:alert('x')",
      '//evil.test',
      '/\\evil.test',
      'https://evil.test',
    ])('replaces %s with the default', async (value) => {
      const res = await t.inject({
        method: 'GET',
        url: `/outfits/new?returnTo=${encodeURIComponent(value)}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('evil.test');
      expect(res.body).not.toContain('javascript:');
      expect(res.body).toContain('href="/outfits"');
      expect(res.body).toContain('name="returnTo" value="/outfits"');
    });

    it('keeps a path on this site', async () => {
      const res = await t.inject({
        method: 'GET',
        url: '/outfits/new?returnTo=/calendar',
      });
      expect(res.body).toContain('href="/calendar"');
      expect(res.body).toContain('name="returnTo" value="/calendar"');
    });
  });

  it('logout clears the cookie and tells the browser to drop its cache', async () => {
    const cookie = await t.register('leaving-device@example.com');
    const res = await t.inject({
      method: 'GET',
      url: '/auth/logout',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers['clear-site-data']).toBe('"cache"');
    const cleared = res.cookies.find((c) => c.name === 'access_token');
    expect(cleared?.value).toBe('');
    expect(cleared?.sameSite).toBe('Lax');
  });

  it('an invite token never reaches the request log', async () => {
    const created = await t.inject({
      method: 'POST',
      url: '/wardrobe-share/create-invite-link',
      payload: { permission: 'VIEW' },
      headers: { 'hx-request': 'true' },
    });
    const token = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(
      created.body,
    )![1];

    const logger = t.app.get(PinoLogger);
    const lines: string[] = [];
    const spies = (['log', 'warn', 'debug', 'error'] as const).map((level) =>
      vi.spyOn(logger, level).mockImplementation((message: unknown) => {
        lines.push(String(message));
      }),
    );
    try {
      const landing = await t.inject({
        method: 'GET',
        url: `/wardrobe-share/invite/${token}`,
        anonymous: true,
      });
      expect(landing.statusCode).toBe(200);
      const declined = await t.inject({
        method: 'POST',
        url: `/wardrobe-share/invite/${token}/decline`,
      });
      expect(declined.statusCode).toBe(302);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^GET \/wardrobe-share\/invite\/:token 200 /),
      ]),
    );
    expect(lines.join('\n')).not.toContain(token);
  });
});
