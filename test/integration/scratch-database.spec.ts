import { Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  createScratchDatabase,
  scratchDatabaseCreatedAt,
  scratchDatabaseName,
  sweepStaleScratchDatabases,
} from '../support/scratch-database';

const ADMIN_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://postgres@localhost:5432/postgres';

async function admin(sql: string): Promise<string[]> {
  const client = new Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ datname: string }>(sql);
    return rows.map((row) => row.datname);
  } finally {
    await client.end();
  }
}

/** The server's clock, which the sweep reads ages by. */
async function serverNow(): Promise<number> {
  const client = new Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ ms: number }>(
      'select extract(epoch from clock_timestamp())::float8 * 1000 as ms',
    );
    return rows[0].ms;
  } finally {
    await client.end();
  }
}

const exists = async (name: string) =>
  (await admin(`select datname from pg_database where datname = '${name}'`))
    .length === 1;

describe('scratch database hygiene', () => {
  it('names carry their creation time', () => {
    const now = Date.UTC(2026, 8, 26, 12, 0, 0);
    const name = scratchDatabaseName('closet_it', now);
    expect(scratchDatabaseCreatedAt(name)).toBe(now);
    expect(scratchDatabaseCreatedAt('closet_it_0123456789ab')).toBeUndefined();
  });

  it('sweeps idle scratch databases older than the cutoff, and nothing else', async () => {
    const now = await serverNow();
    const stale = scratchDatabaseName('closet_it', now - 2 * 60 * 60 * 1000);
    const fresh = scratchDatabaseName('closet_it', now);
    await admin(`create database "${stale}"`);
    await admin(`create database "${fresh}"`);
    try {
      // Asserted on what is left, not on this sweep's list: another run's
      // globalSetup, sweeping the same server, may drop the stale one first.
      const dropped = await sweepStaleScratchDatabases();
      expect(dropped).not.toContain(fresh);
      const left = await admin(
        `select datname from pg_database where datname in ('${stale}', '${fresh}')`,
      );
      expect(left).toEqual([fresh]);
    } finally {
      await admin(`drop database if exists "${stale}"`);
      await admin(`drop database if exists "${fresh}"`);
    }
  });

  it('dates a database by the server, so a spec faking Date into the past is not swept while it boots (#249)', async () => {
    // recap.spec.ts pins yesterday before createTestApp: a name from the
    // faked Date read over an hour old to every other run's sweep, which
    // dropped the database between the boot's migrations and the owner's
    // registration.
    vi.useFakeTimers({
      toFake: ['Date'],
      now: new Date('2026-01-01T00:00:00Z'),
    });
    let database: Awaited<ReturnType<typeof createScratchDatabase>>;
    try {
      database = await createScratchDatabase('closet_it');
    } finally {
      vi.useRealTimers();
    }
    const name = database.env.DATABASE_SCHEMA;
    try {
      const created = scratchDatabaseCreatedAt(name) ?? 0;
      expect(Math.abs((await serverNow()) - created)).toBeLessThan(60_000);
      expect(await sweepStaleScratchDatabases()).not.toContain(name);
      expect(await exists(name)).toBe(true);
    } finally {
      await database.drop();
    }
  });
});
