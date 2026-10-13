import { createHash, randomBytes } from 'node:crypto';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { Client } from 'pg';
import pino from 'pino';
import { MIGRATIONS_FOLDER, runMigrations } from '../../src/db/migrate';

/**
 * A throwaway Postgres database for one test run, created on the server named
 * by TEST_DATABASE_URL (postgres://user:pass@host:port/adminDb, a role that
 * may CREATE DATABASE; CI sets it) or else the shared local pgvault-dev.
 *
 * Used by the integration harness (one per spec file, so files stay isolated
 * and run in parallel) and by the page audit (scripts/audit/, so a run never
 * seeds or changes the development database).
 *
 * `migrated`: cloned from a template this build's migrations have already
 * reached (migratedTemplate), so the app's boot finds the schema up to date
 * instead of running every migration again per spec file. The migration
 * specs, which build a database from an older shape, ask for an empty one.
 */
export interface ScratchDatabaseOptions {
  migrated?: boolean;
}

export interface ScratchDatabase {
  /** DATABASE_* values that point the app at this database. */
  env: Record<string, string>;
  drop: () => Promise<void>;
}

// pgvault-dev, the shared local Postgres for all solo projects: superuser on
// localhost:5432 with trust auth.
const LOCAL_ADMIN_URL = 'postgres://postgres@localhost:5432/postgres';

function adminUrl(): string {
  return process.env.TEST_DATABASE_URL ?? LOCAL_ADMIN_URL;
}

async function withAdmin<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/**
 * The server's clock, in ms: the one both ends of a scratch database's age
 * are read from. Never the process's Date.now(): a spec that fakes Date into
 * the past before createTestApp (recap.spec.ts pins yesterday) would name
 * its live database over an hour old, and another run's sweep dropped it
 * while no connection was open, between the boot's migrations and the
 * owner's registration (#249: "register did not set access_token (status
 * 500)", the insert failing with "database ... does not exist").
 */
async function serverNowMs(client: Client): Promise<number> {
  const { rows } = await client.query<{ ms: number }>(
    'select extract(epoch from clock_timestamp())::float8 * 1000 as ms',
  );
  return rows[0].ms;
}

export async function createScratchDatabase(
  prefix: string,
  { migrated = false }: ScratchDatabaseOptions = {},
): Promise<ScratchDatabase> {
  const url = new URL(adminUrl());
  let name: string;
  try {
    const template = migrated ? await migratedTemplate() : undefined;
    name = await withAdmin(async (client) => {
      const created = scratchDatabaseName(prefix, await serverNowMs(client));
      if (template) {
        // The template's collation (below) comes with the clone.
        await client.query(
          `create database "${created}" template "${template}"`,
        );
      } else {
        await client.query(`create database "${created}" ${EMPTY_DATABASE}`);
      }
      return created;
    });
  } catch (error) {
    throw new Error(
      `Cannot create a scratch database on ${url.host}. Start pgvault-dev, ` +
        'or set TEST_DATABASE_URL to a role that may CREATE DATABASE.',
      { cause: error },
    );
  }
  return {
    env: databaseEnv(url, name),
    // FORCE (Postgres 13+) closes any connection the app has not released.
    drop: () =>
      withAdmin(async (client) => {
        await client.query(`drop database if exists "${name}" with (force)`);
      }),
  };
}

function databaseEnv(url: URL, name: string): Record<string, string> {
  return {
    DATABASE_HOST: url.hostname,
    DATABASE_PORT: url.port || '5432',
    DATABASE_USER: decodeURIComponent(url.username),
    DATABASE_PASS: decodeURIComponent(url.password),
    DATABASE_SCHEMA: name,
    DATABASE_SSL: 'false',
  };
}

// C collation, from template0 (template1 carries the server's): the ordering
// assertions were validated on linux-box's pgvault-dev (C), while CI's stock
// postgres image is en_US.utf8 and sorts "mauve" before "Teal". The pin makes
// every server agree.
const EMPTY_DATABASE = `template template0 locale_provider libc lc_collate 'C' lc_ctype 'C' encoding 'UTF8'`;

const TEMPLATE_LOCK_KEY = 'closet:scratch-template';

/**
 * `closet_tpl_<12 hex>`: the hash of every file in drizzle/, so a new or
 * changed migration names a new template and the old one is swept.
 */
export function migratedTemplateName(): string {
  const digest = createHash('sha256');
  for (const migration of readMigrationFiles({
    migrationsFolder: MIGRATIONS_FOLDER,
  })) {
    digest.update(`${migration.folderMillis}:${migration.hash}\n`);
  }
  return `closet_tpl_${digest.digest('hex').slice(0, 12)}`;
}

/**
 * The database this build's migrations have reached, on the admin server:
 * created and migrated the first time anyone asks (the integration project's
 * globalSetup, test/support/migrated-template-setup.ts, so the workers find
 * it ready), reused by every later run on the same server until drizzle/
 * changes. One advisory lock on the admin connection serializes the makers:
 * a second process waits, then finds it there.
 */
export async function migratedTemplate(): Promise<string> {
  const name = migratedTemplateName();
  const url = new URL(adminUrl());
  await withAdmin(async (client) => {
    await client.query('select pg_advisory_lock(hashtext($1))', [
      TEMPLATE_LOCK_KEY,
    ]);
    const { rowCount } = await client.query(
      'select 1 from pg_database where datname = $1',
      [name],
    );
    if (rowCount) return;
    // Built under a working name and renamed once migrated, so a maker killed
    // mid-way leaves no half-migrated database under the final name.
    const building = `${name}_building`;
    await client.query(`drop database if exists "${building}" with (force)`);
    await client.query(`create database "${building}" ${EMPTY_DATABASE}`);
    const env = databaseEnv(url, building);
    await runMigrations(
      {
        host: env.DATABASE_HOST,
        port: Number(env.DATABASE_PORT),
        database: building,
        user: env.DATABASE_USER,
        password: env.DATABASE_PASS,
        ssl: false,
      },
      pino({ level: 'silent' }),
    );
    await client.query(`alter database "${building}" rename to "${name}"`);
  });
  return name;
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

const SCRATCH_NAME = /^closet_(?:it|audit)_([0-9a-z]+)_[0-9a-f]{8}$/;

/** Creation time in ms from a scratch database name, or undefined. */
export function scratchDatabaseCreatedAt(name: string): number | undefined {
  const match = SCRATCH_NAME.exec(name);
  return match ? parseInt(match[1], 36) * 1000 : undefined;
}

/**
 * Drops scratch databases left behind by killed runs: named by
 * scratchDatabaseName, older than `maxAgeMs` by the server's clock (as
 * createScratchDatabase named them; see serverNowMs), and with no open
 * connection, plus every idle migrated template but this build's. Never WITH
 * (FORCE): a database someone is still using stays. Names from before the
 * timestamp (no age to read) are left alone.
 */
export async function sweepStaleScratchDatabases(
  maxAgeMs = 60 * 60 * 1000,
): Promise<string[]> {
  const current = migratedTemplateName();
  return withAdmin(async (client) => {
    const nowMs = await serverNowMs(client);
    const { rows } = await client.query<{ datname: string }>(
      `select datname from pg_database d
        where datname ~ '^closet_(it|audit|tpl)_'
          and not exists (select 1 from pg_stat_activity a where a.datname = d.datname)`,
    );
    const stale = rows
      .map((row) => row.datname)
      .filter((name) => {
        // Templates of other builds (an older drizzle/, or a half-made one).
        if (name.startsWith('closet_tpl_')) return name !== current;
        const created = scratchDatabaseCreatedAt(name);
        return created !== undefined && nowMs - created > maxAgeMs;
      });
    for (const name of stale) {
      await client.query(`drop database if exists "${name}"`);
    }
    return stale;
  });
}
