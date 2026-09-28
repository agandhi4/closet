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

/**
 * The session timeouts a connection opens with (startup parameters, so they
 * cost no round trip). A stalled transaction holds its row locks, the owner
 * lock included (src/web/auth/queries.ts), until one of these ends it.
 * `lock_timeout` is not here: ownerTransaction sets it for its own
 * transaction (OWNER_LOCK_TIMEOUT_MS).
 */
export interface DbTimeouts {
  /** statement_timeout: the longest any one statement may run. */
  statementMs: number;
  /**
   * idle_in_transaction_session_timeout: how long a transaction may wait on
   * the application between statements before Postgres ends its session (a
   * request stuck on I/O inside a transaction, a client gone mid-way).
   */
  idleInTransactionMs: number;
}

/** The server's pool: every request, timer and job. */
export const SERVER_TIMEOUTS: DbTimeouts = {
  statementMs: 15_000,
  idleInTransactionMs: 30_000,
};

/**
 * Operator-scale work that may legitimately run long: the boot's migrations
 * (their advisory-lock wait included: an overlapping deploy's second server
 * waits out the first's migration) and every CLI (runCli: the seed's
 * one-transaction persona, reconciliation). Long, but bounded, so a hung run
 * still ends on its own.
 */
export const MAINTENANCE_TIMEOUTS: DbTimeouts = {
  statementMs: 10 * 60_000,
  idleInTransactionMs: 5 * 60_000,
};

/**
 * Without `timeouts` a session keeps the database's defaults (none): the
 * cutout listener only LISTENs, and the specs' own clients build fixtures.
 */
export function connectionOptions(
  config: DbConfig,
  timeouts?: DbTimeouts,
): ClientConfig {
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    // pgvault's certificate is self-signed.
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
    ...(timeouts && {
      statement_timeout: timeouts.statementMs,
      idle_in_transaction_session_timeout: timeouts.idleInTransactionMs,
    }),
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
 * One pg Pool and the Drizzle instance over it, its connections opened with
 * `timeouts` (the server's unless a caller says otherwise). The caller owns
 * the pool's lifetime: `db.$client.end()` on shutdown.
 */
export function createDb(
  config: DbConfig,
  logger: Logger,
  timeouts: DbTimeouts = SERVER_TIMEOUTS,
): Db {
  const pool = new TimedPool({
    ...connectionOptions(config, timeouts),
    max: POOL_MAX,
    min: POOL_MIN,
    idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
  });
  // A connection that dies emits 'error', and an 'error' event without a
  // listener kills the process. The pool listens only while a connection is
  // idle in it (Postgres restarted, network dropped), but a checked-out one
  // dies too: idle_in_transaction_session_timeout ends the session of a
  // transaction stalled between statements. So each connection has its own
  // listener for life, and the pool's exists only to be there. A dead
  // connection is not queryable: its transaction's next statement fails, and
  // the pool discards it on release and opens another on demand.
  pool.on('connect', (client) => {
    client.on('error', (error) => {
      logger.error({ err: error }, 'Database connection failed');
    });
  });
  pool.on('error', () => {
    // Logged by the connection's own listener above.
  });
  logger.info(
    `Drizzle pool for ${config.database} on ${config.host}:${config.port} (max ${POOL_MAX}, min ${POOL_MIN}; ` +
      `statement_timeout ${timeouts.statementMs} ms, idle_in_transaction_session_timeout ${timeouts.idleInTransactionMs} ms)`,
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
