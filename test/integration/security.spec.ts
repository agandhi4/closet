import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garment, outfitCalendar, user } from '../../src/db/schema';
import { createGarment } from './garments';
import { APP_ORIGIN, createTestApp, TEST_PASSWORD, TestApp } from './harness';

/**
 * Cross-cutting request security: the same-origin (CSRF) check on every
 * state-changing route; `returnTo` values;
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
    // Two writes of two features, the garments and the calendar.
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
      const garments = await createGarmentFrom(headers);
      expect(garments.statusCode).toBe(403);
      expect(await rows(garment)).toBe(garmentsBefore);

      const entriesBefore = await rows(outfitCalendar);
      const web = await schedule(headers);
      expect(web.statusCode).toBe(403);
      expect(await rows(outfitCalendar)).toBe(entriesBefore);
    });

    // A cross-site page's auto-submitted form, as the browser sends it now
    // that the service worker leaves every navigation post alone (#542):
    // its own Origin (or a cross-site Referer, or an opaque or no Origin),
    // never this site's. Each must change no session: login CSRF signs the
    // victim into the attacker's account; a cross-site sign-out or deletion
    // ends theirs. The deletion carries the right password, which a
    // cross-site page could only have phished: the Origin still refuses it.
    const crossSiteNavigation = {
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
      'sec-fetch-site': 'cross-site',
    };
    describe.each([
      ['another site in Origin', { origin: 'https://evil.test' }],
      ['another site in Referer only', { referer: 'https://evil.test/form' }],
      ['an opaque Origin', { origin: 'null' }],
      ['neither Origin nor Referer', {}],
    ])('a cross-site navigation post with %s', (label, from) => {
      // Each case's own accounts: a taken email would refuse on its own.
      const slug = label.replace(/\W+/g, '-').toLowerCase();
      const post = (url: string, payload: object, cookie?: string) =>
        t.inject({
          method: 'POST',
          url,
          payload,
          headers: {
            ...crossSiteNavigation,
            ...from,
            ...(cookie === undefined ? {} : { cookie }),
          },
          anonymous: cookie === undefined,
          sameOrigin: false,
        });
      // The same-origin hook's own refusal, before any route ran.
      const refusedByOrigin = (res: { statusCode: number; body: string }) =>
        res.statusCode === 403 && res.body === 'Cross-origin request refused';

      it('signs nobody in or up', async () => {
        const login = await post('/auth/login', {
          email: t.owner.email,
          password: TEST_PASSWORD,
        });
        expect(refusedByOrigin(login)).toBe(true);
        expect(login.cookies).toHaveLength(0);

        const email = `planted-${slug}@evil.test`;
        const register = await post('/auth/register', {
          email,
          password: TEST_PASSWORD,
          confirmPassword: TEST_PASSWORD,
        });
        expect(refusedByOrigin(register)).toBe(true);
        expect(register.cookies).toHaveLength(0);
        expect(
          await t.db.select().from(user).where(eq(user.email, email)),
        ).toEqual([]);
      });

      it('signs nobody out and deletes no account', async () => {
        const email = `victim-${slug}@example.com`;
        const cookie = await t.register(email);
        for (const [url, payload] of [
          ['/auth/logout', {}],
          ['/auth/delete-account', { email, password: TEST_PASSWORD }],
        ] as const) {
          const res = await post(url, payload, cookie);
          expect({ url, refused: refusedByOrigin(res) }).toEqual({
            url,
            refused: true,
          });
          expect(res.cookies).toHaveLength(0);
          expect(res.headers['clear-site-data']).toBeUndefined();
        }
        const profile = await t.inject({
          method: 'GET',
          url: '/auth/profile',
          headers: { cookie },
        });
        expect(profile.statusCode).toBe(200);
        expect(
          await t.db.select().from(user).where(eq(user.email, email)),
        ).toHaveLength(1);
      });
    });

    it('refuses a cross-site email change', async () => {
      const change = await t.inject({
        method: 'POST',
        url: '/auth/update-email',
        payload: {
          email: 'hijacked@evil.test',
          confirmEmail: 'hijacked@evil.test',
          currentPassword: TEST_PASSWORD,
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

  describe('returnTo on Styling (the outfit form it replaced)', () => {
    it.each([
      "javascript:alert('x')",
      '//evil.test',
      '/\\evil.test',
      'https://evil.test',
    ])('drops %s', async (value) => {
      const res = await t.inject({
        method: 'GET',
        url: `/styling?returnTo=${encodeURIComponent(value)}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('evil.test');
      expect(res.body).not.toContain('javascript:');
      expect(res.body).not.toContain('name="returnTo"');
    });

    it('keeps a path on this site', async () => {
      const res = await t.inject({
        method: 'GET',
        url: '/styling?returnTo=/calendar',
      });
      expect(res.body).toContain('href="/calendar"');
    });

    it('a saved edit goes nowhere else', async () => {
      const res = await t.inject({
        method: 'POST',
        url: '/styling',
        payload: {
          outfit: '999999',
          garmentId: '1',
          returnTo: 'https://evil.test',
        },
      });
      expect(res.headers.location ?? '').not.toContain('evil.test');
    });
  });

  it('logout clears the cookie and tells the browser to drop its cache', async () => {
    const cookie = await t.register('leaving-device@example.com');
    const res = await t.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(303);
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

    t.logs.clear();
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
    expect(t.logs.messages('info', 'Http')).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^GET \/wardrobe-share\/invite\/:token 200 /),
      ]),
    );
    expect(t.logs.text()).not.toContain(token);
  });
});
