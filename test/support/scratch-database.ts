import { MikroORM } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { randomBytes } from 'node:crypto';

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
  const name = `${prefix}_${randomBytes(6).toString('hex')}`;
  // The admin connection goes through MikroORM itself so no Postgres client
  // dependency is needed beyond what the app already has.
  const run = async (sql: string) => {
    const orm = await MikroORM.init({
      driver: PostgreSqlDriver,
      clientUrl: adminUrl,
      entities: [],
      discovery: { warnWhenNoEntities: false },
      allowGlobalContext: true,
    });
    try {
      await orm.em.getConnection().execute(sql);
    } finally {
      await orm.close();
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
