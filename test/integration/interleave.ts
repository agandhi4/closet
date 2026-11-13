import { sql } from 'drizzle-orm';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Db, Queryable } from '../../src/db/client';

/** How often a wait looks at pg_stat_activity; the wait itself has no deadline. */
const LOOK_EVERY_MS = 20;

/** The backend serving `q`: the connection (or transaction) that will hold a lock. */
export async function backendPid(q: Queryable): Promise<number> {
  const { rows } = await q.execute<{ pid: number }>(
    sql`select pg_backend_pid() as pid`,
  );
  return rows[0].pid;
}

/**
 * How many backends of this database are blocked behind `holderPid`: waiting
 * on a lock it holds, or queued behind a backend that waits on it
 * (pg_blocking_pids, followed transitively). A backend waiting on any other
 * lock is not counted.
 */
export async function blockedBehind(
  db: Queryable,
  holderPid: number,
): Promise<number> {
  const { rows } = await db.execute<{ blocked: number }>(
    sql`with recursive chain(pid) as (
          select a.pid from pg_stat_activity a
           where a.datname = current_database()
             and ${holderPid}::int = any(pg_blocking_pids(a.pid))
          union
          select a.pid from pg_stat_activity a
            join chain c on c.pid = any(pg_blocking_pids(a.pid))
           where a.datname = current_database()
        )
        select count(*)::int as blocked from chain`,
  );
  return rows[0].blocked;
}

/**
 * Resolves once at least `count` backends are blocked behind `holderPid`
 * (blockedBehind), so an unrelated wait (a bcrypt hash, a third writer's
 * lock) never ends it early. No deadline of its own: a wait that never ends
 * is the test's timeout. The one way to sequence a race on a lock
 * (test/AGENTS.md).
 */
export async function waitForBlockedOn(
  db: Queryable,
  holderPid: number,
  count = 1,
): Promise<void> {
  while ((await blockedBehind(db, holderPid)) < count) {
    await sleep(LOOK_EVERY_MS);
  }
}

/**
 * Two writers interleaved deterministically, never by timing: `first` runs
 * in a transaction held open once it has written, `second` starts and must
 * then wait on the first's lock (waitForBlockedOn), then `meanwhile` runs (a third write
 * committed while the second waits), then the first commits. Answers both.
 * A first writer that fails ends the wait at once instead of hanging.
 * Used by every spec that proves two writers take turns on a lock
 * (owner-lock, access-tokens, push-revocation and others: grep interleave).
 */
export async function interleave<A, B>(
  db: Db,
  first: (tx: Queryable) => Promise<A>,
  second: () => Promise<B>,
  meanwhile?: () => Promise<unknown>,
): Promise<[A, B]> {
  let wrote!: () => void;
  const written = new Promise<void>((resolve) => (wrote = resolve));
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let holderPid!: number;
  const a = db.transaction(async (tx) => {
    const result = await first(tx);
    holderPid = await backendPid(tx);
    wrote();
    await released;
    return result;
  });
  await Promise.race([written, a]);
  const b = second();
  await waitForBlockedOn(db, holderPid);
  try {
    await meanwhile?.();
  } finally {
    release();
  }
  return Promise.all([a, b]);
}
