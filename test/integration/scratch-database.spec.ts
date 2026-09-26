import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import {
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

describe('scratch database hygiene', () => {
  it('names carry their creation time', () => {
    const now = Date.UTC(2026, 8, 26, 12, 0, 0);
    const name = scratchDatabaseName('closet_it', now);
    expect(scratchDatabaseCreatedAt(name)).toBe(now);
    expect(scratchDatabaseCreatedAt('closet_it_0123456789ab')).toBeUndefined();
  });

  it('sweeps idle scratch databases older than the cutoff, and nothing else', async () => {
    const now = Date.now();
    const stale = scratchDatabaseName('closet_it', now - 2 * 60 * 60 * 1000);
    const fresh = scratchDatabaseName('closet_it', now);
    await admin(`create database "${stale}"`);
    await admin(`create database "${fresh}"`);
    try {
      const dropped = await sweepStaleScratchDatabases(now);
      expect(dropped).toContain(stale);
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
});
