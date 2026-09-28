import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDb,
  type Db,
  type DbTimeouts,
  SERVER_TIMEOUTS,
} from '../../src/db/client';
import { wardrobePlan } from '../../src/db/schema';
import {
  lockOwner,
  OWNER_LOCK_TIMEOUT_MS,
  ownerTransaction,
} from '../../src/web/auth/queries';
import { HttpError } from '../../src/web/errors';
import { t as translate } from '../../src/web/i18n';
import { createTestApp, type TestApp } from './harness';

/**
 * Database timeouts (#134, src/db/CLAUDE.md, Timeouts): one stuck
 * transaction must not wedge an owner's writes. The server's pool opens its
 * connections with statement_timeout and idle_in_transaction_session_timeout;
 * ownerTransaction bounds its lock waits (lock_timeout), so a writer queued
 * behind a held owner lock fails fast with a 503 instead of hanging.
 */

describe('database timeouts', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  /** A second pool on the app's database, with timeouts short enough to watch. */
  async function withPool<T>(
    timeouts: DbTimeouts,
    use: (db: Db) => Promise<T>,
  ): Promise<T> {
    const db = createDb(t.database, t.logger, timeouts);
    try {
      return await use(db);
    } finally {
      await db.$client.end();
    }
  }

  const setting = async (db: Db, name: string) => {
    const { rows } = await db.execute<{ value: string }>(
      sql`select current_setting(${name}) as value`,
    );
    return rows[0].value;
  };

  it("opens the server pool's connections with its statement and idle-in-transaction timeouts", async () => {
    expect(SERVER_TIMEOUTS).toEqual({
      statementMs: 15_000,
      idleInTransactionMs: 30_000,
    });
    expect(await setting(t.db, 'statement_timeout')).toBe('15s');
    expect(await setting(t.db, 'idle_in_transaction_session_timeout')).toBe(
      '30s',
    );
    // Only an owner transaction bounds its lock waits.
    expect(await setting(t.db, 'lock_timeout')).toBe('0');
    const inside = await ownerTransaction(t.db, t.owner.id, 'spec', (tx) =>
      tx
        .execute<{
          value: string;
        }>(sql`select current_setting('lock_timeout') as value`)
        .then(({ rows }) => rows[0].value),
    );
    expect(inside).toBe(`${OWNER_LOCK_TIMEOUT_MS / 1000}s`);
  });

  it('fails a writer queued behind a held owner lock within the lock timeout, as a 503, and logs the owner and writer', async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const holder = t.db.transaction(async (tx) => {
      await lockOwner(tx, t.owner.id);
      held();
      await released;
    });
    await Promise.race([holding, holder]);

    const started = performance.now();
    const res = await t.inject({
      method: 'POST',
      url: '/wardrobe/plans',
      payload: { name: 'Behind a stuck write', notes: '' },
    });
    const waited = performance.now() - started;
    release();
    await holder;

    expect(res.statusCode).toBe(503);
    expect(res.body).toContain(translate('WARDROBE_BUSY'));
    expect(waited).toBeGreaterThanOrEqual(OWNER_LOCK_TIMEOUT_MS - 50);
    // The timeout, not the statement's 15 s or the holder's release.
    expect(waited).toBeLessThan(SERVER_TIMEOUTS.statementMs);
    expect(t.logs.messages('warn', 'Web')).toContainEqual(
      `POST /wardrobe/plans -> 503: ${translate('WARDROBE_BUSY')} (createPlan for owner ${t.owner.id} waited ${OWNER_LOCK_TIMEOUT_MS} ms for a lock)`,
    );
    const written = await t.db
      .select({ id: wardrobePlan.id })
      .from(wardrobePlan)
      .where(eq(wardrobePlan.name, 'Behind a stuck write'));
    expect(written).toEqual([]);

    // Once the holder is gone the same write goes through.
    const retried = await t.inject({
      method: 'POST',
      url: '/wardrobe/plans',
      payload: { name: 'Behind a stuck write', notes: '' },
    });
    expect(retried.statusCode, retried.body).toBe(303);
  });

  it('answers a writer whose owner is gone with a 404, never an unlocked write', async () => {
    let ran = false;
    const refused = await ownerTransaction(t.db, 2_000_000_000, 'spec', () => {
      ran = true;
      return Promise.resolve();
    }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(HttpError);
    expect((refused as HttpError).statusCode).toBe(404);
    expect(ran).toBe(false);
  });

  it('ends a transaction left idle past idle_in_transaction_session_timeout, and the pool recovers', async () => {
    await withPool(
      { statementMs: SERVER_TIMEOUTS.statementMs, idleInTransactionMs: 200 },
      async (db) => {
        let pid = 0;
        const stalled = await db
          .transaction(async (tx) => {
            const { rows } = await tx.execute<{ pid: number }>(
              sql`select pg_backend_pid() as pid`,
            );
            pid = rows[0].pid;
            // A request stuck on I/O inside its transaction.
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            await tx.execute(sql`select 1`);
          })
          .then(
            () => 'committed',
            () => 'failed',
          );
        expect(stalled).toBe('failed');
        // Postgres ended the session (not just the statement), and the
        // process heard it instead of dying of an unheard 'error'.
        const { rows } = await t.db.execute<{ alive: boolean }>(
          sql`select exists (select 1 from pg_stat_activity where pid = ${pid}) as alive`,
        );
        expect(rows[0].alive).toBe(false);
        expect(
          t.logs.records.some(
            (record) =>
              record.level === 'error' &&
              record.msg === 'Database connection failed',
          ),
        ).toBe(true);
        // The dead connection was dropped; the next query gets a live one.
        expect(await setting(db, 'idle_in_transaction_session_timeout')).toBe(
          '200ms',
        );
      },
    );
  });

  it('cancels a statement past statement_timeout', async () => {
    await withPool(
      {
        statementMs: 200,
        idleInTransactionMs: SERVER_TIMEOUTS.idleInTransactionMs,
      },
      async (db) => {
        const outcome = await db.execute(sql`select pg_sleep(2)`).then(
          () => 'finished',
          // drizzle's error names the statement; the driver's, its cause.
          (error: Error) => String((error.cause as Error | undefined)?.message),
        );
        expect(outcome).toBe('canceling statement due to statement timeout');
      },
    );
  });
});
