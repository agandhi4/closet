import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { type ClientConfig, Pool } from 'pg';
import * as schema from './schema';

/**
 * Where the database is, independent of how the host framework reads its
 * configuration: DbModule builds it from ConfigService (the DATABASE_* vars
 * declared in app.module.ts); a plain Fastify entry point builds the same
 * object and calls createDb() and runMigrations() the same way.
 */
export interface DbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
}

/** The two things the data layer reports; Nest's Logger and pino both fit. */
export interface DbLogger {
  info(message: string): void;
  error(message: string, error: unknown): void;
}

export type Db = NodePgDatabase<typeof schema> & { $client: Pool };

export function connectionOptions(config: DbConfig): ClientConfig {
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    // pgvault's certificate is self-signed; same policy as MikroORM's pool.
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
  };
}

// Small on purpose while MikroORM keeps its own pool beside this one. `min`
// keeps connections open across idle periods: a fresh one costs ~11 ms, which
// the server audit measured on every request once MikroORM's pool had shrunk.
const POOL_MAX = 5;
const POOL_MIN = 2;
const POOL_IDLE_TIMEOUT_MS = 30_000;

/**
 * One pg Pool and the Drizzle instance over it. The caller owns the pool's
 * lifetime: `db.$client.end()` on shutdown.
 */
export function createDb(config: DbConfig, logger: DbLogger): Db {
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
    logger.error('Idle database connection failed', error);
  });
  logger.info(
    `Drizzle pool for ${config.database} on ${config.host}:${config.port} (max ${POOL_MAX}, min ${POOL_MIN})`,
  );
  return drizzle(pool, { schema });
}
