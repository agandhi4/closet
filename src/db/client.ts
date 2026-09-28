import {
  drizzle,
  type NodePgDatabase,
  type NodePgQueryResultHKT,
} from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { type ClientConfig, Pool, type PoolClient, type PoolConfig } from 'pg';
import type { Config } from '../config';
import type { Logger } from '../logger';
import {
  currentRequestTiming,
  type RequestTiming,
} from '../metrics/request-timing';
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
// request once the old ORM's pool had shrunk. The server holds one more
// connection outside the pool while its cutout queue runs (the LISTEN
// connection, src/cutout/listener.ts): at most POOL_MAX + 1 per server.
const POOL_MAX = 10;
const POOL_MIN = 2;
const POOL_IDLE_TIMEOUT_MS = 30_000;

/**
 * One pg Pool and the Drizzle instance over it. The caller owns the pool's
 * lifetime: `db.$client.end()` on shutdown.
 */
export function createDb(config: DbConfig, logger: Logger): Db {
  const pool = new TimedPool({
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

/**
 * A Pool that adds, to the request it serves, the time from asking for a
 * connection to giving it back: the `db` of Server-Timing
 * (src/metrics/request-timing.ts). Drizzle reaches the pool two ways, both
 * through connect(): `pool.query` connects and releases around one query,
 * and a transaction holds one connection throughout. The request is read
 * when connect() is called, in the caller's async context; the pool's own
 * callbacks may run in another request's (a waiting connect is served from
 * whoever releases), so they only carry what was captured here. `release`
 * is the pool's own event, emitted synchronously as a client is returned.
 */
class TimedPool extends Pool {
  private readonly held = new WeakMap<
    PoolClient,
    { timing: RequestTiming; since: number }
  >();

  constructor(config: PoolConfig) {
    super(config);
    this.on('release', (_error, client) => {
      const hold = this.held.get(client);
      if (!hold) return;
      this.held.delete(client);
      hold.timing.dbMs += performance.now() - hold.since;
    });
  }

  override connect(): Promise<PoolClient>;
  override connect(
    callback: (
      err: Error | undefined,
      client: PoolClient | undefined,
      done: (release?: unknown) => void,
    ) => void,
  ): void;
  override connect(
    callback?: (
      err: Error | undefined,
      client: PoolClient | undefined,
      done: (release?: unknown) => void,
    ) => void,
  ): Promise<PoolClient> | void {
    const timing = currentRequestTiming();
    const since = performance.now();
    const hold = (client: PoolClient | undefined) => {
      if (timing && client) this.held.set(client, { timing, since });
    };
    if (callback) {
      super.connect((err, client, done) => {
        hold(client);
        callback(err, client, done);
      });
      return;
    }
    return super.connect().then((client) => {
      hold(client);
      return client;
    });
  }
}
