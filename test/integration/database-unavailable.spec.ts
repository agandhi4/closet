import { sql } from 'drizzle-orm';
import { createServer, type Server, type Socket, connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, SERVER_TIMEOUTS } from '../../src/db/client';
import { isDatabaseUnavailable } from '../../src/db/errors';
import { describeError } from '../../src/web/errors';
import { t as translate } from '../../src/web/i18n';
import { scratchServer } from '../support/scratch-database';
import { type SentryStub, startSentryStub } from '../support/sentry-stub';
import { createTestApp, type TestApp, unescapeHtml } from './harness';

/**
 * The database out of reach (#643): a pgvault restart or a NAS reboot. A
 * signed-in page answers the 503 busy page (HTML, Retry-After), never the
 * error handler's JSON, the outage is one error-tracker event rather than
 * one per request, and a host that stops answering fails a connection
 * within its timeout instead of the kernel's. The app reaches Postgres
 * through a relay the spec controls, so "down" is a closed port, not a
 * stopped server.
 */

/** A TCP relay to Postgres that the spec can close (refused) and reopen. */
async function startRelay(target: { host: string; port: number }) {
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
  };
  const server: Server = createServer((client) => {
    const upstream = connect(target);
    track(client);
    track(upstream);
    client.pipe(upstream).pipe(client);
  });
  const listen = (port: number) =>
    new Promise<void>((resolve) =>
      server.listen(port, '127.0.0.1', () => resolve()),
    );
  await listen(0);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('relay has no port');
  }
  const port = address.port;
  return {
    port,
    /** Closes the port and cuts every open connection: the database is gone. */
    async refuse() {
      const closed = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      for (const socket of sockets) socket.destroy();
      await closed;
    },
    restore: () => listen(port),
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        if (server.listening) server.close(() => resolve());
        else resolve();
      }),
  };
}

describe('with the database out of reach', () => {
  let relay: Awaited<ReturnType<typeof startRelay>>;
  let stub: SentryStub;
  let t: TestApp;

  beforeAll(async () => {
    relay = await startRelay(scratchServer());
    stub = await startSentryStub();
    t = await createTestApp({
      DATABASE_HOST: '127.0.0.1',
      DATABASE_PORT: String(relay.port),
      SENTRY_DSN: stub.dsn,
    });
  });

  afterAll(async () => {
    await relay?.restore().catch(() => undefined);
    await t?.cleanup();
    await relay?.close();
    await stub?.close();
  });

  const wardrobe = (headers: Record<string, string> = {}) =>
    t.inject({ method: 'GET', url: '/wardrobe', headers });

  it('answers a signed-in page with the busy page, and an outage is one captured event', async () => {
    expect((await wardrobe()).statusCode).toBe(200);
    await t.errors.flush(5_000);
    stub.events.length = 0;
    await relay.refuse();

    for (let i = 0; i < 10; i += 1) {
      const res = await wardrobe();
      expect(res.statusCode).toBe(503);
      expect(res.headers['content-type']).toMatch(/^text\/html/);
      expect(res.headers['retry-after']).toBe('5');
      expect(unescapeHtml(res.body)).toContain(
        translate('DATABASE_UNAVAILABLE'),
      );
    }
    // An htmx fragment request gets #642's toast, not a page.
    const fragment = await wardrobe({ 'hx-request': 'true' });
    expect(fragment.statusCode).toBe(503);
    expect(fragment.body).toBe('');
    expect(fragment.headers['hx-trigger']).toContain('closet:request-failed');

    await t.errors.flush(5_000);
    expect(stub.events).toHaveLength(1);
    // Every request is a warn line with the driver's error: the pool's idle
    // connections, cut by the relay, fail as lost (no code); every new one is
    // refused.
    const busy = t.logs.records.filter(
      (record) =>
        record.logger === 'Web' &&
        record.level === 'warn' &&
        String(record.msg).startsWith('GET /wardrobe -> 503'),
    );
    expect(busy).toHaveLength(11);
    expect(busy.at(-1)?.err).toMatchObject({ code: 'ECONNREFUSED' });
    const outageBegan =
      'Database unavailable: requests answer busy until it is back';
    expect(t.logs.messages('warn', 'Db')).toEqual([outageBegan]);

    // Back: the pool's first new connection ends the outage, and the next
    // one begins another, captured again. (The stub cannot count that
    // capture: Sentry's Dedupe integration drops an event identical to the
    // one before it.)
    await relay.restore();
    expect((await wardrobe()).statusCode).toBe(200);
    expect(t.logs.messages('info', 'Db')).toContainEqual(
      expect.stringMatching(
        /^Database reachable again after \d+ s; 11 request\(s\) answered busy$/,
      ),
    );
    await relay.refuse();
    expect((await wardrobe()).statusCode).toBe(503);
    expect(t.logs.messages('warn', 'Db')).toEqual([outageBegan, outageBegan]);
    await relay.restore();
  });

  // The blackholed host: the TCP connection opens and nothing answers the
  // startup message. Without connectionTimeoutMillis that waited on the
  // kernel, minutes; a short one here keeps the spec quick.
  it('fails a connection to a host that never answers within the connect timeout', async () => {
    const held = new Set<Socket>();
    const silent = createServer((socket) => {
      held.add(socket);
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) =>
      silent.listen(0, '127.0.0.1', () => resolve()),
    );
    const address = silent.address();
    if (address === null || typeof address === 'string') {
      throw new Error('no port');
    }
    const connectMs = 300;
    const db = createDb(
      { ...t.database, host: '127.0.0.1', port: address.port },
      t.logger,
      { ...SERVER_TIMEOUTS, connectMs },
    );
    try {
      const started = performance.now();
      const failure = await db.execute(sql`select 1`).then(
        () => undefined,
        (error: unknown) => error,
      );
      const elapsedMs = performance.now() - started;
      expect(failure).toBeInstanceOf(Error);
      expect(isDatabaseUnavailable(failure)).toBe(true);
      expect(describeError(failure)).toMatchObject({
        status: 503,
        code: 'busy',
        retryAfterSeconds: 5,
        databaseUnavailable: true,
      });
      expect(elapsedMs).toBeGreaterThanOrEqual(connectMs - 50);
      expect(elapsedMs).toBeLessThan(connectMs + 2_000);
    } finally {
      await db.$client.end();
      for (const socket of held) socket.destroy();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });
});
