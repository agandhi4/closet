import type { UniqueConstraint } from './schema';

/** Postgres' SQLSTATE for unique_violation. */
const UNIQUE_VIOLATION = '23505';

interface PgError {
  code?: unknown;
  constraint?: unknown;
}

/**
 * Whether `error` is Postgres refusing a write on `constraint`: a
 * concurrent write took the value first. The constraint is required, not
 * optional, because a table can carry several unique indexes: a writer that
 * matched any unique violation once mapped the plan table's "one active plan"
 * race to "name already taken" (#34 review). A violation of any other
 * constraint answers false, so the caller rethrows it instead of turning it
 * into a user-facing message. drizzle wraps the driver's error as `cause`, so
 * the chain is walked.
 */
export function isUniqueViolation(
  error: unknown,
  constraint: UniqueConstraint,
): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    const pg = current as Error & PgError;
    if (pg.code === UNIQUE_VIOLATION) return pg.constraint === constraint;
    current = current.cause;
  }
  return false;
}
