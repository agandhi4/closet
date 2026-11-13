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

interface PgError {
  code?: unknown;
  constraint?: unknown;
}

/**
 * The driver's error in `error`'s chain, the first with a SQLSTATE: drizzle
 * wraps it as `cause` of an error whose message is the failed statement.
 */
function driverError(error: unknown): PgError | undefined {
  let current: unknown = error;
  while (current instanceof Error) {
    const pg = current as Error & PgError;
    if (typeof pg.code === 'string') return pg;
    current = current.cause;
  }
  return undefined;
}

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
