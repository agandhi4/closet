import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import jwt from 'jsonwebtoken';
import { PassThrough, Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { user } from '../../src/db/schema';
import { runSetPassword } from '../../src/maintenance/set-password';
import {
  createSessionTokens,
  passwordFingerprint,
} from '../../src/web/auth/tokens';
import { captureLogs } from '../support/log-capture';
import { createGarment } from './garments';
import {
  createTestApp,
  TEST_PASSWORD,
  type TestApp,
  uniqueClient,
  userIdOf,
} from './harness';
import { planEntry, takeSelfie } from './selfies';

/**
 * A session ended away from the device (a password changed on another one
 * or by `user:set-password`, the account deleted elsewhere, a rotated
 * ACCESS_TOKEN_SECRET, expiry) must not leave that account's private cache
 * behind: the next request carrying the dead cookie gets the cookie cleared
 * and `Clear-Site-Data: "cache"`, whatever it asked for (a page, an htmx
 * fragment, a selfie, the public login page). The session resolver does it
 * (createSessionResolver, src/web/auth/session.ts). A request without the
 * cookie, a live session and the device that changed its own password get
 * neither. Sign-out's own header is in account.spec.ts and security.spec.ts.
 */

// The app's signing secret, so a spec can sign what a server once issued:
// an expired token, one from before a rotation.
const SECRET = 'session-revocation-secret-0123456789abcdef';
const NEW_PASSWORD = 'NewPassword456!';

/** The requests a revoked device may send next, as a browser sends them. */
const NEXT_REQUESTS = [
  {
    label: 'a page navigation',
    url: '/wardrobe',
    headers: { 'sec-fetch-mode': 'navigate' },
    status: 302,
  },
  {
    label: 'an htmx fragment',
    url: '/wardrobe',
    headers: { 'hx-request': 'true', 'sec-fetch-mode': 'cors' },
    status: 401,
  },
  {
    label: 'a selfie <img>',
    url: '/selfies/thumb/00000000-0000-4000-8000-000000000000.webp?v=1',
    headers: { 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' },
    status: 401,
  },
  {
    label: 'the public login page',
    url: '/auth/login',
    headers: { 'sec-fetch-mode': 'navigate' },
    status: 200,
  },
] as const;

function expectSessionEnded(res: LightMyRequestResponse): void {
  expect(res.headers['clear-site-data']).toBe('"cache"');
  const cleared = res.cookies.find((c) => c.name === 'access_token');
  expect(cleared?.value).toBe('');
  expect(cleared?.path).toBe('/');
  expect(cleared?.expires?.getTime()).toBeLessThanOrEqual(Date.now());
}

function expectNothingCleared(res: LightMyRequestResponse): void {
  expect(res.headers['clear-site-data']).toBeUndefined();
  expect(res.cookies.find((c) => c.name === 'access_token')).toBeUndefined();
}

describe('a revoked session clears the device', () => {
  let t: TestApp;

  const accountRow = async (email: string) =>
    (await t.db.query.user.findFirst({ where: eq(user.email, email) }))!;

  /** Every shape of next request with the dead cookie ends the session. */
  const expectEndedOnEveryRequest = async (deadCookie: string) => {
    for (const next of NEXT_REQUESTS) {
      const res = await t.inject({
        method: 'GET',
        url: next.url,
        headers: { ...next.headers, cookie: deadCookie },
      });
      expect(res.statusCode, next.label).toBe(next.status);
      expectSessionEnded(res);
      if (next.status === 302) {
        expect(res.headers.location).toBe('/auth/login');
      }
      if (next.status === 401) {
        expect(res.headers['hx-redirect']).toBe('/auth/login');
      }
    }
  };

  beforeAll(async () => {
    t = await createTestApp({ ACCESS_TOKEN_SECRET: SECRET });
  });

  afterAll(() => t?.cleanup());

  it('a request without a cookie gets neither header: nothing was signed in', async () => {
    for (const next of NEXT_REQUESTS) {
      const res = await t.inject({
        method: 'GET',
        url: next.url,
        headers: next.headers,
        anonymous: true,
      });
      expect(res.statusCode, next.label).toBe(next.status);
      expectNothingCleared(res);
    }
  });

  it('a live session gets neither header', async () => {
    const res = await t.inject({ method: 'GET', url: '/wardrobe' });
    expect(res.statusCode).toBe(200);
    expectNothingCleared(res);
  });

  it('a password change ends the other device, whose selfie is refused with the header; this device keeps its session and its cache', async () => {
    const email = 'changer@example.com';
    const thisDevice = await t.register(email);
    const otherDevice = await t.login(email);

    // The other device has a selfie in its HTTP cache, served privately.
    const garmentId = await createGarment(t, {
      name: 'Mirror tee',
      cookie: otherDevice,
    });
    const created = await t.inject({
      method: 'POST',
      url: '/outfits',
      payload: { name: 'Mirror', category: 'shirt', garmentId: `${garmentId}` },
      headers: { cookie: otherDevice },
    });
    const outfitId = Number(/(\d+)$/.exec(created.headers.location!)![1]);
    const entryId = await planEntry(t, outfitId, t.today(), otherDevice);
    const { fileName } = await takeSelfie(t, entryId, otherDevice);
    const selfieUrl = `/selfies/thumb/${fileName}?v=1`;
    const image = { 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' };
    const cached = await t.inject({
      method: 'GET',
      url: selfieUrl,
      headers: { ...image, cookie: otherDevice },
    });
    expect(cached.statusCode).toBe(200);
    expect(cached.headers['cache-control']).toContain('private');
    expectNothingCleared(cached);

    const changed = await t.inject({
      method: 'POST',
      url: '/auth/change-password',
      payload: {
        currentPassword: TEST_PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmPassword: NEW_PASSWORD,
      },
      headers: { cookie: thisDevice },
    });
    expect(changed.statusCode).toBe(302);
    // This device's answer reissues its cookie and clears nothing.
    expect(changed.headers['clear-site-data']).toBeUndefined();
    const replacement = changed.cookies.find((c) => c.name === 'access_token');
    expect(replacement?.value).toBeTruthy();
    const survivor = `access_token=${replacement!.value}`;

    // The other device's next request, whatever it is, ends it there.
    const refused = await t.inject({
      method: 'GET',
      url: selfieUrl,
      headers: { ...image, cookie: otherDevice },
    });
    expect(refused.statusCode).toBe(401);
    expect(refused.headers['hx-redirect']).toBe('/auth/login');
    expectSessionEnded(refused);
    await expectEndedOnEveryRequest(otherDevice);
    expect(t.logs.messages('info', 'Session')).toContain(
      `Rejected access token (password fingerprint mismatch for user ${await userIdOf(t, email)}): cookie cleared, Clear-Site-Data sent`,
    );

    // The device that changed it stays signed in, cache and all.
    for (const url of ['/wardrobe', '/auth/profile?passwordChanged=1']) {
      const res = await t.inject({
        method: 'GET',
        url,
        headers: { cookie: survivor },
      });
      expect(res.statusCode).toBe(200);
      expectNothingCleared(res);
    }
  });

  it('user:set-password ends every session, each on its next request', async () => {
    const email = 'recovered@example.com';
    const session = await t.register(email);
    const { logger } = captureLogs();
    const status = await runSetPassword({
      args: [email],
      db: t.db,
      input: Readable.from([`${NEW_PASSWORD}\n`]),
      output: new PassThrough(),
      errors: new PassThrough(),
      logger,
    });
    expect(status).toBe(0);

    await expectEndedOnEveryRequest(session);
  });

  it('deleting the account clears this device, and the other device on its next request', async () => {
    const email = 'leaving@example.com';
    const thisDevice = await t.register(email);
    const otherDevice = await t.login(email);

    const deleted = await t.inject({
      method: 'POST',
      url: '/auth/delete-account',
      payload: { email, password: TEST_PASSWORD },
      headers: { cookie: thisDevice },
    });
    expect(deleted.statusCode).toBe(302);
    expectSessionEnded(deleted);

    await expectEndedOnEveryRequest(otherDevice);
  });

  it('a rotated ACCESS_TOKEN_SECRET ends a session signed with the old one', async () => {
    const email = 'rotated@example.com';
    await t.register(email);
    const signedBefore = createSessionTokens(
      'the-secret-before-rotation-0123456789abcdef',
    ).issue(await accountRow(email));

    await expectEndedOnEveryRequest(`access_token=${signedBefore}`);
  });

  it('an expired token ends the session', async () => {
    const email = 'expired@example.com';
    await t.register(email);
    const row = await accountRow(email);
    const expired = jwt.sign(
      {
        userId: row.id,
        email: row.email,
        pwf: passwordFingerprint(row.password),
        exp: Math.floor(Date.now() / 1000) - 60,
      },
      SECRET,
      { algorithm: 'HS256' },
    );

    await expectEndedOnEveryRequest(`access_token=${expired}`);
  });

  it('a garbled cookie is ended too', async () => {
    await expectEndedOnEveryRequest('access_token=not-a-jwt');
  });

  it('signing in over a dead cookie keeps the new session', async () => {
    const email = 'again@example.com';
    await t.register(email);
    const res = await t.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: TEST_PASSWORD },
      headers: { ...uniqueClient(), cookie: 'access_token=not-a-jwt' },
    });
    expect(res.statusCode).toBe(302);
    // One Set-Cookie for the name: the new token, not the clearing.
    const tokens = res.cookies.filter((c) => c.name === 'access_token');
    expect(tokens).toHaveLength(1);
    const fresh = `access_token=${tokens[0].value}`;
    const profile = await t.inject({
      method: 'GET',
      url: '/auth/profile',
      headers: { cookie: fresh },
    });
    expect(profile.statusCode).toBe(200);
  });
});
