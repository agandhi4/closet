import {
  drizzle,
  type NodePgDatabase,
  type NodePgQueryResultHKT,
} from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { type ClientConfig, Pool } from 'pg';
import type { Config } from '../config';
import type { Logger } from '../logger';
import * as schema from './schema';

/**
 * Where the database is: the DATABASE_* variables (src/config.ts), as
 * dbConfig() reads them for the server and the CLIs alike.
 */
export interface DbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
}

export type Db = NodePgDatabase<typeof schema> & { $client: Pool };

/**
 * What a query function needs to run: the Drizzle instance or a transaction
 * opened on it (`db.transaction(async (tx) => ...)`). A write that must
 * commit with others takes this instead of `Db`, so its caller decides the
 * transaction (the outfit form saves and schedules in one).
 */
export type Queryable = PgDatabase<NodePgQueryResultHKT, typeof schema>;

export function dbConfig(config: Config): DbConfig {
  return {
    host: config.DATABASE_HOST,
    port: config.DATABASE_PORT,
    database: config.DATABASE_SCHEMA,
    user: config.DATABASE_USER,
    password: config.DATABASE_PASS,
    ssl: config.DATABASE_SSL,
  };
}

export function connectionOptions(config: DbConfig): ClientConfig {
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    // pgvault's certificate is self-signed.
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
  };
}

// The app's only pool. Modest because pgvault is one Postgres shared by every
// homelab app, and a household never needs more than a handful of concurrent
// queries (a page is one to three). `min` keeps connections open across idle
// periods: a fresh one costs ~11 ms, which the server audit measured on every
// request once the old ORM's pool had shrunk.
const POOL_MAX = 10;
const POOL_MIN = 2;
const POOL_IDLE_TIMEOUT_MS = 30_000;

/**
 * One pg Pool and the Drizzle instance over it. The caller owns the pool's
 * lifetime: `db.$client.end()` on shutdown.
 */
export function createDb(config: DbConfig, logger: Logger): Db {
  const pool = new Pool({
    ...connectionOptions(config),
    max: POOL_MAX,
    min: POOL_MIN,
    idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
  });
  // An idle connection that dies (Postgres restarted, network dropped) is
  // reported here, and an 'error' event without a listener kills the
  // process. The pool discards the connection and opens a new one on demand.
  pool.on('error', (error) => {
    logger.error({ err: error }, 'Idle database connection failed');
  });
  logger.info(
    `Drizzle pool for ${config.database} on ${config.host}:${config.port} (max ${POOL_MAX}, min ${POOL_MIN})`,
  );
  return drizzle(pool, { schema });
}
