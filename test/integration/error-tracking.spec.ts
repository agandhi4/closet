import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BUILD_INFO } from '../../src/build-info';
import { user } from '../../src/db/schema';
import {
  type SentryEvent,
  type SentryStub,
  startSentryStub,
} from '../support/sentry-stub';
import { createTestApp, type TestApp } from './harness';

/**
 * Error tracking (#117): with SENTRY_DSN the server's crashes, failed jobs
 * and the pages' script errors reach Bugsink, here a stub at the DSN that
 * the real Sentry transport posts to. No event may carry the session cookie
 * or its JWT. Without a DSN nothing loads and the beacon's route does not
 * exist.
 */

// What public/js/errors.js posts (sendBeacon: a text/plain string).
const BEACON_HEADERS = {
  'content-type': 'text/plain;charset=UTF-8',
  'sec-fetch-mode': 'no-cors',
};

const CHROMIUM_STACK = [
  "TypeError: Cannot read properties of undefined (reading 'id')",
  '    at pick (http://localhost/js/styling.js?v=1:12:9)',
  '    at HTMLButtonElement.<anonymous> (http://localhost/js/styling.js?v=1:40:3)',
].join('\n');

describe('error tracking, off without a DSN', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  it('loads no error script and has no beacon route', async () => {
    const page = await t.inject({ method: 'GET', url: '/wardrobe' });
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain('/js/errors.js');
    const beacon = await t.inject({
      method: 'POST',
      url: '/errors/client',
      headers: BEACON_HEADERS,
      payload: JSON.stringify({ message: 'Error: boom' }),
    });
    expect(beacon.statusCode).toBe(404);
  });
});

describe('error tracking with a DSN (a stub Bugsink)', () => {
  let stub: SentryStub;
  let t: TestApp;
  /** The owner's session cookie value: a JWT. */
  let jwt: string;

  beforeAll(async () => {
    stub = await startSentryStub();
    t = await createTestApp({ SENTRY_DSN: stub.dsn });
    jwt = t.owner.cookie.slice('access_token='.length);
  });

  afterAll(async () => {
    await t?.cleanup();
    await stub?.close();
  });

  beforeEach(() => {
    stub.events.length = 0;
    stub.bodies.length = 0;
  });

  /** Everything sent so far, as the tracker's HTTP bodies. */
  const sent = () => stub.bodies.join('\n');

  /** Waits for `count` events, then a moment more for any extra one. */
  async function exactlyEvents(count: number): Promise<SentryEvent[]> {
    await stub.waitForEvents(count);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(stub.events).toHaveLength(count);
    return stub.events;
  }

  const beacon = (payload: string, cookie?: string) =>
    t.inject({
      method: 'POST',
      url: '/errors/client',
      headers: { ...BEACON_HEADERS, ...(cookie && { cookie }) },
      payload,
    });

  it('loads the error script first on signed-in pages only', async () => {
    const page = await t.inject({ method: 'GET', url: '/wardrobe' });
    const scripts = [...page.body.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(scripts[0]).toMatch(/^\/js\/errors\.js\?v=/);
    const login = await t.inject({
      method: 'GET',
      url: '/auth/login',
      anonymous: true,
    });
    expect(login.statusCode).toBe(200);
    expect(login.body).not.toContain('/js/errors.js');
  });

  it("sends a route's crash with its template and user, without the cookie or JWT", async () => {
    // The failure echoes the session cookie, as a careless error message
    // might: the scrubbing, not luck, keeps it out of the event.
    expect(t.owner.cookie).toMatch(/^access_token=[\w.-]+$/);
    await t.db.execute(
      sql.raw(`create function leak_cookie() returns trigger language plpgsql as $$
        begin raise exception 'garment insert failed for %', '${t.owner.cookie}'; end $$`),
    );
    await t.db.execute(
      sql`create trigger leak_cookie before insert on garment for each row execute function leak_cookie()`,
    );
    const res = await t
      .inject({
        method: 'POST',
        url: '/wardrobe',
        payload: { name: 'Leaky linen shirt', category: 'shirt' },
      })
      .finally(async () => {
        await t.db.execute(sql`drop trigger leak_cookie on garment`);
        await t.db.execute(sql`drop function leak_cookie()`);
      });
    expect(res.statusCode).toBe(500);

    const [event] = await exactlyEvents(1);
    expect(event.tags).toMatchObject({
      source: 'route',
      route: '/wardrobe',
      method: 'POST',
    });
    expect(event.user).toEqual({ id: String(t.owner.id) });
    expect(event.environment).toBe('test');
    expect(event.request).toBeUndefined();
    const values = event.exception?.values ?? [];
    expect(values.map((value) => value.value).join('\n')).toContain(
      'garment insert failed for access_token=[Filtered]',
    );
    // Neither the cookie, its JWT, nor the query's parameters left.
    expect(sent()).not.toContain(jwt);
    expect(sent()).not.toContain(t.owner.cookie);
    expect(sent()).not.toContain('Leaky linen shirt');
  });

  it('sends a failed job, and never a refusal', async () => {
    const missing = await t.inject({ method: 'GET', url: '/nowhere' });
    expect(missing.statusCode).toBe(404);
    expect((await beacon('not json')).statusCode).toBe(400);

    // server.ts wraps every timer's run in timeJob; this is one that fails.
    const failing = t.metrics.timeJob('reconciliation', () =>
      Promise.reject(new Error('Storage reconciliation could not list files')),
    );
    await expect(failing()).rejects.toThrow('could not list files');

    const [event] = await exactlyEvents(1);
    expect(event.tags).toMatchObject({ source: 'job', job: 'reconciliation' });
    expect(event.exception?.values?.at(-1)).toMatchObject({
      type: 'Error',
      value: 'Storage reconciliation could not list files',
    });
  });

  it("forwards a page's error with its route template, release and stack", async () => {
    const res = await beacon(
      JSON.stringify({
        message: `TypeError: Cannot read properties of undefined (reading 'id') access_token=${jwt}`,
        stack: CHROMIUM_STACK,
        route: '/wardrobe/:id',
        release: '0123456789abcdef0123456789abcdef01234567',
      }),
    );
    expect(res.statusCode).toBe(204);

    const [event] = await exactlyEvents(1);
    expect(event.tags).toMatchObject({
      source: 'client',
      route: '/wardrobe/:id',
      // What the page claims: visible, but never the event's release.
      page_release: '0123456789abcdef0123456789abcdef01234567',
    });
    // The server's own (no build.json here, so none): a signed-in user
    // cannot file events under a release of their choosing.
    expect(event.release).toBe(BUILD_INFO.sha);
    expect(event.release).not.toBe('0123456789abcdef0123456789abcdef01234567');
    expect(event.user).toEqual({ id: String(t.owner.id) });
    const [exception] = event.exception?.values ?? [];
    expect(exception.type).toBe('ClientError');
    expect(exception.value).toMatch(/^TypeError: Cannot read properties/);
    // Chromium's frames parse; the stack is kept whole beside them.
    expect(
      exception.stacktrace?.frames?.map((frame) => frame.function),
    ).toContain('pick');
    expect(event.contexts?.client).toEqual({ stack: CHROMIUM_STACK });
    expect(sent()).not.toContain(jwt);
  });

  it('names a route the app does not have `unknown`', async () => {
    const res = await beacon(
      JSON.stringify({ message: 'Error: boom', route: '/wardrobe/42' }),
    );
    expect(res.statusCode).toBe(204);
    const [event] = await exactlyEvents(1);
    expect(event.tags).toMatchObject({ source: 'client', route: 'unknown' });
    expect(sent()).not.toContain('/wardrobe/42');
  });

  it('refuses a report without a session, from another site, too large or malformed', async () => {
    const anonymous = await t.inject({
      method: 'POST',
      url: '/errors/client',
      anonymous: true,
      headers: BEACON_HEADERS,
      payload: JSON.stringify({ message: 'Error: boom' }),
    });
    expect(anonymous.statusCode).toBe(401);
    const crossSite = await t.inject({
      method: 'POST',
      url: '/errors/client',
      headers: { ...BEACON_HEADERS, origin: 'http://evil.example' },
      payload: JSON.stringify({ message: 'Error: boom' }),
    });
    expect(crossSite.statusCode).toBe(403);
    const noOrigin = await t.inject({
      method: 'POST',
      url: '/errors/client',
      sameOrigin: false,
      headers: BEACON_HEADERS,
      payload: JSON.stringify({ message: 'Error: boom' }),
    });
    expect(noOrigin.statusCode).toBe(403);
    const tooLarge = await beacon(
      JSON.stringify({ message: 'Error: boom', stack: 'x'.repeat(17 * 1024) }),
    );
    expect(tooLarge.statusCode).toBe(413);
    for (const payload of [
      'message=boom',
      JSON.stringify({ message: '' }),
      JSON.stringify({ message: 'x'.repeat(1001) }),
      JSON.stringify({ message: 'Error: boom', release: 'not-a-sha' }),
    ]) {
      expect((await beacon(payload)).statusCode).toBe(400);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(stub.events).toEqual([]);
  });

  it('caps a flood of reports at 10 a minute per user', async () => {
    // A user of its own: the other tests' reports count for the owner.
    const cookie = await t.register('flood@example.com');
    const [flooder] = await t.db
      .select({ id: user.id })
      .from(user)
      .where(sql`${user.email} = 'flood@example.com'`);
    const statuses: number[] = [];
    for (let i = 0; i < 15; i += 1) {
      const res = await beacon(
        JSON.stringify({ message: `Error: loop ${i}` }),
        cookie,
      );
      statuses.push(res.statusCode);
    }
    expect(statuses).toEqual([...Array(10).fill(204), ...Array(5).fill(429)]);
    const events = await exactlyEvents(10);
    expect(new Set(events.map((event) => event.user?.id))).toEqual(
      new Set([String(flooder.id)]),
    );
  });
});
