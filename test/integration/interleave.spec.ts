import { Client } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { connectionOptions } from '../../src/db/client';
import { createTestApp, type TestApp } from './harness';
import { blockedBehind, waitForBlockedOn } from './interleave';

/**
 * The race helper waits for a block on the holder's own lock: a backend
 * waiting on another lock never satisfies it (it used to count any Lock wait
 * in the database, and a 1 s default deadline made it flaky under load).
 */

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t?.cleanup();
});

it('counts only backends blocked behind the holder, not behind another lock', async () => {
  const [holder, other, waiter, second] = [1, 2, 3, 4].map(
    () => new Client(connectionOptions(t.database)),
  );
  await Promise.all([holder, other, waiter, second].map((c) => c.connect()));
  try {
    const pids: number[] = [];
    for (const [client, key] of [
      [holder, 9_621_001],
      [other, 9_621_002],
    ] as const) {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock($1)', [key]);
      pids.push(
        (await client.query<{ pid: number }>('select pg_backend_pid() as pid'))
          .rows[0].pid,
      );
    }
    const [holderBackend, otherBackend] = pids;

    // `waiter` waits on the OTHER lock: a Lock wait, but not the holder's.
    await waiter.query('begin');
    const waiting = waiter.query(
      'select pg_advisory_xact_lock($1)',
      [9_621_002],
    );
    await waitForBlockedOn(t.db, otherBackend);
    expect(await blockedBehind(t.db, holderBackend)).toBe(0);

    // `second` waits on the holder's lock: now, and only now, it is blocked.
    await second.query('begin');
    const blocked = second.query(
      'select pg_advisory_xact_lock($1)',
      [9_621_001],
    );
    await waitForBlockedOn(t.db, holderBackend);
    expect(await blockedBehind(t.db, holderBackend)).toBe(1);
    expect(await blockedBehind(t.db, otherBackend)).toBe(1);

    await holder.query('commit');
    await blocked;
    await other.query('commit');
    await waiting;
  } finally {
    await Promise.all(
      [holder, other, waiter, second].map((c) => c.end().catch(() => {})),
    );
  }
});
