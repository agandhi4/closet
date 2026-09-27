import { inArray, sql } from 'drizzle-orm';
import { connect, createServer, type Socket } from 'node:net';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { settlesWithin } from '../../src/cutout/deadline';
import { LISTENER_APPLICATION_NAME } from '../../src/cutout/listener';
import { CutoutQueue } from '../../src/cutout/queue';
import { initialCutoutState } from '../../src/cutout/state';
import { createDb, type Db, type DbConfig } from '../../src/db/client';
import { file } from '../../src/db/schema';
import { insertPhotoRow } from '../../src/web/files/queries';
import { eventually, fakeRunner, halfMask } from './cutouts';
import { jpegPhoto, photoRow } from './garments';
import { createTestApp, type TestApp } from './harness';
import { silentLogger } from './logger';

/**
 * The cutout queue picks up photos queued by another process (#36): a CLI
 * or a second server writes through its own connection, so this server's
 * wake() is never called. A write notifies (LISTEN/NOTIFY, on commit), the
 * listener reconnects after losing its connection and then looks, and an
 * idle poll catches whatever no notification announced. "Another process"
 * here is a second pool on the same database, writing through the app's
 * own insertPhotoRow, as the seed does.
 */

/** The listener's backends on the spec's database (pg_stat_activity). */
async function listenerBackends(t: TestApp): Promise<number[]> {
  const { rows } = await t.db.execute<{ pid: number }>(
    sql`select pid from pg_stat_activity
         where datname = current_database()
           and application_name = ${LISTENER_APPLICATION_NAME}`,
  );
  return rows.map((row) => row.pid);
}

/** Backends of the spec's database waiting on a lock (pg_stat_activity). */
async function lockWaiters(t: TestApp): Promise<number> {
  const { rows } = await t.db.execute<{ waiting: number }>(
    sql`select count(*)::int as waiting from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock'`,
  );
  return rows[0].waiting;
}

/**
 * A TCP relay to Postgres on `port` that can go silent: freeze() stops
 * passing bytes either way while every socket stays open, as a peer behind a
 * dropped route does, so the server's answer to pg's orderly end() (closing
 * the connection) never arrives. Half-open, so a client's FIN is not answered
 * for the server either.
 */
async function silenceableRelay({ host, port }: DbConfig) {
  const sockets: Socket[] = [];
  let frozen = false;
  const server = createServer({ allowHalfOpen: true }, (inbound) => {
    const outbound = connect({ host, port, allowHalfOpen: true });
    sockets.push(inbound, outbound);
    for (const [from, to] of [
      [inbound, outbound],
      [outbound, inbound],
    ]) {
      from.on('data', (chunk) => {
        if (!frozen) to.write(chunk);
      });
      from.on('error', () => to.destroy());
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The relay is not listening on a port');
  }
  return {
    port: address.port,
    freeze() {
      frozen = true;
    },
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** How many of the queue's lines at `level` start with `prefix` so far. */
function linesStarting(t: TestApp, level: string, prefix: string): number {
  return t.logs
    .messages(level, 'Cutout')
    .filter((line) => line.startsWith(prefix)).length;
}

const listenerConnects = (t: TestApp) =>
  linesStarting(t, 'info', 'Cutout listener connected');
const listenerDrops = (t: TestApp) =>
  linesStarting(t, 'warn', 'Cutout listener lost its connection');

/**
 * A photo queued the way another process queues one: bytes stored, then the
 * pending row inserted through `other`. `notify: false` inserts the row
 * without insertPhotoRow, as if the notification were lost.
 */
async function queueElsewhere(
  t: TestApp,
  other: Db,
  { notify }: { notify: boolean },
): Promise<string> {
  const row = await t.photos.storeImage(
    {
      stream: Readable.from(await jpegPhoto(400, 300)),
      mimetype: 'image/jpeg',
      filename: 'elsewhere.jpg',
    },
    t.owner.id,
  );
  const pending = { ...row, ...initialCutoutState('pending') };
  if (notify) {
    await other.transaction((tx) => insertPhotoRow(tx, pending));
  } else {
    await other.insert(file).values(pending);
  }
  return row.fileName;
}

async function statusOf(t: TestApp, fileName: string) {
  return (await photoRow(t, fileName))?.cutoutStatus;
}

describe('cutout queue: notifications from another process', () => {
  let t: TestApp;
  let other: Db;

  beforeAll(async () => {
    // Nothing but a notification or a reconnect can start a job here.
    t = await createTestApp({ CUTOUT_POLL_SECONDS: '3600' });
    other = createDb(t.database, silentLogger);
  });

  afterEach(async () => {
    await t.cutouts.stop();
  });

  afterAll(async () => {
    await other?.$client.end();
    await t?.cleanup();
  });

  /** Starts the queue and waits until its listener is listening. */
  async function startListening() {
    const connects = listenerConnects(t);
    const runner = fakeRunner();
    t.cutouts.start(runner);
    await eventually('the listener to connect', () =>
      Promise.resolve(listenerConnects(t) > connects),
    );
    return runner;
  }

  it('runs a photo another process queued, promptly, through its notification', async () => {
    const runner = await startListening();

    const fileName = await queueElsewhere(t, other, { notify: true });

    await eventually(
      'the cutout',
      async () => (await statusOf(t, fileName)) === 'ready',
    );
    expect(runner.calls).toBe(1);
    expect(t.logs.messages('debug', 'Cutout')).toContain(
      'Cutout listener notified: a cutout was queued',
    );
    expect(t.logs.text()).not.toContain('Cutout poll found');
  });

  it('holds one connection of its own, named, beside the pool', async () => {
    await startListening();

    expect(await listenerBackends(t)).toHaveLength(1);
  });

  it('reconnects after its connection is killed and runs what it missed', async () => {
    await startListening();
    // Queued without a notification while listening: with the poll an hour
    // away, only the look after a reconnect can find it.
    const missed = await queueElsewhere(t, other, { notify: false });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await statusOf(t, missed)).toBe('pending');
    const connects = listenerConnects(t);

    const [pid] = await listenerBackends(t);
    await t.db.execute(sql`select pg_terminate_backend(${pid})`);

    await eventually(
      'the missed cutout',
      async () => (await statusOf(t, missed)) === 'ready',
    );
    expect(t.logs.messages('warn', 'Cutout')).toContainEqual(
      expect.stringMatching(
        /^Cutout listener lost its connection \(.+\); reconnecting in 1 s$/,
      ),
    );
    expect(listenerConnects(t)).toBe(connects + 1);
    const backends = await listenerBackends(t);
    expect(backends).toHaveLength(1);
    expect(backends[0]).not.toBe(pid);

    // Listening again: the next notification is heard.
    const next = await queueElsewhere(t, other, { notify: true });
    await eventually(
      'the next cutout',
      async () => (await statusOf(t, next)) === 'ready',
    );
  });

  it('closes the listener on stop, and a pending reconnect with it', async () => {
    await startListening();
    expect(await listenerBackends(t)).toHaveLength(1);

    await t.cutouts.stop();

    await eventually(
      'the listener backend to go',
      async () => (await listenerBackends(t)).length === 0,
    );
    expect(t.logs.messages('info', 'Cutout')).toContain(
      'Cutout listener closed',
    );

    // Stopped while waiting to reconnect: the retry never runs.
    await startListening();
    const connects = listenerConnects(t);
    const drops = listenerDrops(t);
    const [pid] = await listenerBackends(t);
    await t.db.execute(sql`select pg_terminate_backend(${pid})`);
    await eventually('the drop to be noticed', () =>
      Promise.resolve(listenerDrops(t) > drops),
    );
    await t.cutouts.stop();
    // Past the first reconnect's 1 s delay.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(listenerConnects(t)).toBe(connects);
    expect(await listenerBackends(t)).toHaveLength(0);
  });

  it('never opens a listener while the queue is not running', async () => {
    // The harness and the CLIs build the queue but never start it.
    expect(await listenerBackends(t)).toHaveLength(0);
  });

  it('stops while its loop awaits a claim, without waiting for the poll', async () => {
    await startListening();
    // The file table held, the next claim waits on its lock: stop() lands
    // while the loop awaits the claim, when there is no sleep to wake yet.
    // It used to go to sleep for the poll interval (an hour here) after.
    const holder = await other.$client.connect();
    try {
      await holder.query('begin');
      await holder.query('lock table file in exclusive mode');
      t.cutouts.wake();
      await eventually(
        'the claim to wait on the lock',
        async () => (await lockWaiters(t)) > 0,
      );
      const stopped = t.cutouts.stop();
      await holder.query('rollback');

      expect(await settlesWithin(stopped, 5_000)).toBe(true);
    } finally {
      holder.release();
    }
    expect(await listenerBackends(t)).toHaveLength(0);
  });

  it('stops for good when its runner fails to close', async () => {
    const runner = fakeRunner();
    runner.close = () => Promise.reject(new Error('The model process hung'));
    t.cutouts.start(runner);
    await t.cutouts.whenIdle();

    await t.cutouts.stop();

    expect(t.logs.messages('error', 'Cutout')).toContain(
      'Cutout runner failed to close',
    );
    // Stopped: it starts again.
    await startListening();
  });

  it('stops within its bound when the database stops answering', async () => {
    // A queue whose listener connects through a relay that then goes
    // silent: pg's orderly end() waits for the server to close the
    // connection, which never happens, so the socket has to be destroyed.
    const relay = await silenceableRelay(t.database);
    const queue = new CutoutQueue({
      db: other,
      database: { ...t.database, host: '127.0.0.1', port: relay.port },
      photos: t.photos,
      logger: t.logger.child({ context: 'Cutout' }),
      pollMs: 3_600_000,
    });
    try {
      const connects = listenerConnects(t);
      queue.start(fakeRunner());
      await eventually('the relayed listener to connect', () =>
        Promise.resolve(listenerConnects(t) > connects),
      );
      relay.freeze();
      const startedAt = Date.now();

      await queue.stop();

      // The listener's 5 s close timeout, and not much more.
      expect(Date.now() - startedAt).toBeLessThan(7_000);
      expect(t.logs.messages('warn', 'Cutout')).toContain(
        'Cutout listener connection did not close within 5 s; destroying its socket',
      );
    } finally {
      await queue.stop();
      await relay.close();
    }
  });
});

describe('cutout queue: the idle poll', () => {
  let t: TestApp;
  let other: Db;

  beforeAll(async () => {
    t = await createTestApp({ CUTOUT_POLL_SECONDS: '1' });
    other = createDb(t.database, silentLogger);
  });

  afterEach(async () => {
    await t.cutouts.stop();
  });

  afterAll(async () => {
    await other?.$client.end();
    await t?.cleanup();
  });

  it('finds a photo whose notification never came', async () => {
    const runner = fakeRunner();
    t.cutouts.start(runner);
    await t.cutouts.whenIdle();

    const fileName = await queueElsewhere(t, other, { notify: false });

    await eventually(
      'the polled cutout',
      async () => (await statusOf(t, fileName)) === 'ready',
    );
    expect(runner.calls).toBe(1);
    expect(t.logs.messages('info', 'Cutout')).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^Cutout poll found photo \\d+ \\(${fileName.slice(0, 8)}\\) pending without a notification$`,
        ),
      ),
    );
  });

  /** Queues `count` photos from the other process, each notified. */
  async function queueMany(count: number, afterEach?: () => void) {
    const fileNames: string[] = [];
    for (let i = 0; i < count; i++) {
      fileNames.push(await queueElsewhere(t, other, { notify: true }));
      afterEach?.();
    }
    return fileNames;
  }

  function rowsOf(fileNames: string[]) {
    return t.db
      .select({
        status: file.cutoutStatus,
        version: file.version,
        attempts: file.cutoutAttempts,
      })
      .from(file)
      .where(inArray(file.fileName, fileNames));
  }

  async function allReady(fileNames: string[]) {
    await eventually(
      'every cutout',
      async () =>
        (await rowsOf(fileNames)).every((row) => row.status === 'ready'),
      10_000,
    );
    // Let a poll or two pass over the finished rows.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
  }

  /** The queue's lines matching `pattern` about any of `fileNames`. */
  function linesAbout(fileNames: string[], pattern: RegExp): string[] {
    return t.logs
      .messages('info', 'Cutout')
      .filter(
        (line) =>
          pattern.test(line) &&
          fileNames.some((name) => line.includes(`(${name.slice(0, 8)})`)),
      );
  }

  // A little latency per job, so claims, notifications and polls overlap.
  const slowly = () =>
    new Promise<Buffer>((resolve) => setTimeout(() => resolve(halfMask()), 20));

  it('runs each photo once when notifications, wakes and the poll all fire', async () => {
    const runner = fakeRunner(slowly);
    t.cutouts.start(runner);

    const fileNames = await queueMany(8, () => t.cutouts.wake());
    await allReady(fileNames);

    expect(runner.calls).toBe(fileNames.length);
    expect((await rowsOf(fileNames)).map((row) => row.attempts)).toEqual(
      fileNames.map(() => 1),
    );
    expect(linesAbout(fileNames, /^Cutout started/)).toHaveLength(
      fileNames.length,
    );
  });

  /**
   * A second server on one database (an overlapping deploy): a queue on its
   * own pool with its own listener, beside the app's. Both hear every
   * notification and poll every second.
   */
  function secondServer() {
    return new CutoutQueue({
      db: other,
      database: t.database,
      photos: t.photos,
      logger: t.logger.child({ context: 'Cutout' }),
      pollMs: 1_000,
    });
  }

  it('runs one pending photo once when two servers hear its notification (#45)', async () => {
    // Slow enough that both servers look while the job runs: without the
    // lease the second claimed the started (still pending) row and ran it too.
    const slower = () =>
      new Promise<Buffer>((resolve) =>
        setTimeout(() => resolve(halfMask()), 300),
      );
    const second = secondServer();
    const first = fakeRunner(slower);
    const secondRunner = fakeRunner(slower);
    t.cutouts.start(first);
    second.start(secondRunner);
    try {
      await t.cutouts.whenIdle();
      await second.whenIdle();

      const [fileName] = await queueMany(1);
      await allReady([fileName]);

      expect(first.calls + secondRunner.calls).toBe(1);
      expect((await rowsOf([fileName]))[0]).toEqual({
        status: 'ready',
        version: 2,
        attempts: 1,
      });
      expect(linesAbout([fileName], /^Cutout started/)).toHaveLength(1);
      expect(linesAbout([fileName], /^Cutout discarded/)).toHaveLength(0);
    } finally {
      await second.stop();
    }
  });

  it('runs each photo once when two servers hear the same notifications and poll', async () => {
    // SKIP LOCKED keeps the servers apart during a claim, the lease while
    // the job runs: every photo is run by one server, once, and written
    // once.
    const second = secondServer();
    const first = fakeRunner(slowly);
    const secondRunner = fakeRunner(slowly);
    t.cutouts.start(first);
    second.start(secondRunner);
    try {
      const fileNames = await queueMany(8);
      await allReady(fileNames);

      expect(
        (await rowsOf(fileNames)).map(({ status, version, attempts }) => ({
          status,
          version,
          attempts,
        })),
      ).toEqual(
        fileNames.map(() => ({ status: 'ready', version: 2, attempts: 1 })),
      );
      expect(first.calls + secondRunner.calls).toBe(fileNames.length);
      expect(linesAbout(fileNames, /^Cutout started/)).toHaveLength(
        fileNames.length,
      );
      expect(linesAbout(fileNames, /^Cutout ready/)).toHaveLength(
        fileNames.length,
      );
      expect(linesAbout(fileNames, /^Cutout discarded/)).toHaveLength(0);
    } finally {
      await second.stop();
    }
  });
});
