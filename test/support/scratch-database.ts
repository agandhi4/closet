import { randomBytes } from 'node:crypto';
import { Client } from 'pg';

/**
 * A throwaway Postgres database for one test run, created on the server named
 * by TEST_DATABASE_URL (postgres://user:pass@host:port/adminDb, a role that
 * may CREATE DATABASE; CI sets it) or else the shared local pgvault-dev.
 *
 * Used by the integration harness (one per spec file, so files stay isolated
 * and run in parallel) and by scripts/load-test.ts (so a local run never
 * seeds the development database).
 */
export interface ScratchDatabase {
  /** DATABASE_* values that point the app at this database. */
  env: Record<string, string>;
  drop: () => Promise<void>;
}

// pgvault-dev, the shared local Postgres for all solo projects: superuser on
// localhost:5432 with trust auth.
const LOCAL_ADMIN_URL = 'postgres://postgres@localhost:5432/postgres';

export async function createScratchDatabase(
  prefix: string,
): Promise<ScratchDatabase> {
  const adminUrl = process.env.TEST_DATABASE_URL ?? LOCAL_ADMIN_URL;
  const url = new URL(adminUrl);
  const name = scratchDatabaseName(prefix, Date.now());
  const run = async (sql: string) => {
    const client = new Client({ connectionString: adminUrl });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  };

  try {
    await run(`create database "${name}"`);
  } catch (error) {
    throw new Error(
      `Cannot create a scratch database on ${url.host}. Start pgvault-dev, ` +
        'or set TEST_DATABASE_URL to a role that may CREATE DATABASE.',
      { cause: error },
    );
  }
  return {
    env: {
      DATABASE_HOST: url.hostname,
      DATABASE_PORT: url.port || '5432',
      DATABASE_USER: decodeURIComponent(url.username),
      DATABASE_PASS: decodeURIComponent(url.password),
      DATABASE_SCHEMA: name,
      DATABASE_SSL: 'false',
    },
    // FORCE (Postgres 13+) closes any connection the app has not released.
    drop: () => run(`drop database if exists "${name}" with (force)`),
  };
}

/**
 * `<prefix>_<created, unix seconds base 36>_<random>`. The creation time is in
 * the name because a killed run (`npm run check` stops the tests when another
 * check fails) never reaches its afterAll, and Postgres records no creation
 * time for a database: the sweep below needs the age from somewhere.
 */
export function scratchDatabaseName(prefix: string, nowMs: number): string {
  const created = Math.floor(nowMs / 1000).toString(36);
  return `${prefix}_${created}_${randomBytes(4).toString('hex')}`;
}

const SCRATCH_NAME = /^closet_(?:it|load)_([0-9a-z]+)_[0-9a-f]{8}$/;

/** Creation time in ms from a scratch database name, or undefined. */
export function scratchDatabaseCreatedAt(name: string): number | undefined {
  const match = SCRATCH_NAME.exec(name);
  return match ? parseInt(match[1], 36) * 1000 : undefined;
}

/**
 * Drops scratch databases left behind by killed runs: named by
 * scratchDatabaseName, older than `maxAgeMs`, and with no open connection.
 * Never WITH (FORCE): a database someone is still using stays. Names from
 * before the timestamp (no age to read) are left alone.
 */
export async function sweepStaleScratchDatabases(
  nowMs: number,
  maxAgeMs = 60 * 60 * 1000,
): Promise<string[]> {
  const adminUrl = process.env.TEST_DATABASE_URL ?? LOCAL_ADMIN_URL;
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ datname: string }>(
      `select datname from pg_database d
        where datname ~ '^closet_(it|load)_'
          and not exists (select 1 from pg_stat_activity a where a.datname = d.datname)`,
    );
    const stale = rows
      .map((row) => row.datname)
      .filter((name) => {
        const created = scratchDatabaseCreatedAt(name);
        return created !== undefined && nowMs - created > maxAgeMs;
      });
    for (const name of stale) {
      await client.query(`drop database if exists "${name}"`);
    }
    return stale;
  } finally {
    await client.end();
  }
}
