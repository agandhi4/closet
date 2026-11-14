import { DrizzleQueryError } from 'drizzle-orm/errors';
import { causeChain, driverError } from '../driver-error';
import type { UniqueConstraint } from './schema';

/** Postgres' SQLSTATE for unique_violation. */
const UNIQUE_VIOLATION = '23505';
/** lock_not_available: a lock wait ran past lock_timeout (or NOWAIT). */
const LOCK_NOT_AVAILABLE = '55P03';
/**
 * The sync triggers' own SQLSTATE (closet_sync_stamp,
 * drizzle/0052_sync-triggers.sql): an insert whose client id has a
 * tombstone, a replayed create of a row since deleted.
 */
const DELETED_CLIENT_ID = 'CL410';

/**
 * Whether `error` is Postgres refusing a write on `constraint`: a
 * concurrent write took the value first. The constraint is required, not
 * optional, because a table can carry several unique indexes: a writer that
 * matched any unique violation once mapped the plan table's "one active plan"
 * race to "name already taken" (#34 review). A violation of any other
 * constraint answers false, so the caller rethrows it instead of turning it
 * into a user-facing message.
 */
export function isUniqueViolation(
  error: unknown,
  constraint: UniqueConstraint,
): boolean {
  const pg = driverError(error);
  return pg?.code === UNIQUE_VIOLATION && pg.constraint === constraint;
}

/** Whether `error` is a lock wait that ran past the transaction's lock_timeout. */
export function isLockTimeout(error: unknown): boolean {
  return driverError(error)?.code === LOCK_NOT_AVAILABLE;
}

/**
 * Whether `error` is the sync triggers refusing a replayed create: its
 * client id names a row of the same table that was deleted
 * (sync_tombstone). The writer answers it as gone (a 410), never by
 * creating the row again.
 */
export function isDeletedClientId(error: unknown): boolean {
  return driverError(error)?.code === DELETED_CLIENT_ID;
}

/**
 * The pool could not open a connection (TimedPool.connect, client.ts): the
 * one typed failure every path to the database shares, Drizzle's single
 * statements (pool.query) and its transactions (pool.connect, unwrapped by
 * Drizzle) alike. The driver's reason is its cause.
 */
export class DatabaseUnreachable extends Error {
  constructor(cause: unknown) {
    super('Could not connect to the database', { cause });
    this.name = 'DatabaseUnreachable';
  }
}

/**
 * pg-pool's own error when a caller's wait for a pooled connection to come
 * free ran past connectionTimeoutMillis: raised before any socket is opened,
 * so it says the pool is full, not that the database is gone. Its exact
 * message is the only mark (no code); re-check it when bumping pg-pool.
 */
const POOL_QUEUE_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect';

/** Whether `error` is pg-pool's queue timeout (TimedPool.connect classifies). */
export function isPoolQueueTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === POOL_QUEUE_TIMEOUT_MESSAGE;
}

/**
 * Every pooled connection stayed busy past connectMs (TimedPool.connect):
 * load, with the database answering. The web layer answers it 503 `busy`
 * like a held lock (describeError), never as an outage: no error-tracker
 * event, and DatabaseOutage is left alone.
 */
export class PoolExhausted extends Error {
  constructor(cause: unknown) {
    super('Every database connection is busy', { cause });
    this.name = 'PoolExhausted';
  }
}

export function isPoolExhausted(error: unknown): boolean {
  return (
    error instanceof Error &&
    causeChain(error).some((e) => e instanceof PoolExhausted)
  );
}

/** node-postgres's client-side query_timeout (pinned, src/db/AGENTS.md). */
const QUERY_READ_TIMEOUT_MESSAGE = 'Query read timeout';

/** Whether `error` is node-postgres failing a query on query_timeout (TimedClient). */
export function isQueryReadTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === QUERY_READ_TIMEOUT_MESSAGE;
}

/**
 * Node's errno names for a socket to the database that failed under a
 * query: reset or timed out with the host gone. Only counted inside a
 * Drizzle query error or DatabaseUnreachable: the same names come from an
 * outbound fetch, which is not the database.
 */
const SOCKET_ERRNOS = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
]);

/**
 * SQLSTATEs of a server going away: class 08 (connection exception), and
 * admin_shutdown, crash_shutdown and cannot_connect_now (57P01-03: a restart
 * ending sessions, a database still starting).
 */
const SERVER_GONE_SQLSTATES = new Set(['57P01', '57P02', '57P03']);

/**
 * node-postgres (pinned, src/db/AGENTS.md) fails a query on a lost
 * connection without a code, so only its exact messages say it: the
 * client-side query timeout (query_timeout: the host stopped answering), a
 * socket that closed under a query, a client already broken, and a client
 * ended under its transaction (TimedClient ends one on a read timeout, so
 * the transaction's ROLLBACK fails with this, not with the timeout).
 * Re-check them when bumping pg.
 */
const CONNECTION_LOST_MESSAGES = new Set([
  QUERY_READ_TIMEOUT_MESSAGE,
  'Connection terminated unexpectedly',
  'Client has encountered a connection error and is not queryable',
  'Client was closed and is not queryable',
]);

/**
 * Whether `error` says the database cannot be reached, rather than that one
 * statement failed: the request may succeed in a moment with nothing changed
 * on our side (the web layer's 503 `busy`, describeError). A connection the
 * pool could not open, a SQLSTATE of the server going away, or a query
 * whose connection was lost. A statement_timeout (57014) is not one: the
 * server answered.
 */
export function isDatabaseUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const chain = causeChain(error);
  if (chain.some((e) => e instanceof DatabaseUnreachable)) return true;
  const code = driverError(error)?.code;
  if (
    code !== undefined &&
    (code.startsWith('08') || SERVER_GONE_SQLSTATES.has(code))
  ) {
    return true;
  }
  if (!chain.some((e) => e instanceof DrizzleQueryError)) return false;
  return (
    (code !== undefined && SOCKET_ERRNOS.has(code)) ||
    chain.some((e) => CONNECTION_LOST_MESSAGES.has(e.message))
  );
}
