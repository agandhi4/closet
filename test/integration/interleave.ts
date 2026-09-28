import { sql } from 'drizzle-orm';
import { expect } from 'vitest';
import type { Db, Queryable } from '../../src/db/client';

/**
 * Two writers interleaved deterministically, never by timing: `first` runs
 * in a transaction held open once it has written, `second` starts and must
 * then wait on a lock (the spec polls pg_stat_activity until exactly one
 * backend of this database waits), then `meanwhile` runs (a third write
 * committed while the second waits), then the first commits. Answers both.
 * A first writer that fails ends the wait at once instead of hanging.
 * Used by owner-lock.spec.ts, outfit-saves.spec.ts and trips.spec.ts.
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
  const a = db.transaction(async (tx) => {
    const result = await first(tx);
    wrote();
    await released;
    return result;
  });
  await Promise.race([written, a]);
  const b = second();
  await expect
    .poll(async () => {
      const { rows } = await db.execute<{ waiting: number }>(
        sql`select count(*)::int as waiting from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'`,
      );
      return rows[0].waiting;
    })
    .toBe(1);
  try {
    await meanwhile?.();
  } finally {
    release();
  }
  return Promise.all([a, b]);
}
