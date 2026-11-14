/**
 * The one walk of an error's cause chain, shared by the logger (errorFields:
 * which reason leads the line, which `code` it carries) and the database's
 * classifiers (src/db/errors.ts: a unique violation, a lock timeout, the
 * database unreachable). Pure: below the logger in scripts/ci/layers.conf.
 */

/** The error and its causes, outermost first; a cycle ends the walk. */
export function causeChain(error: Error): Error[] {
  const chain: Error[] = [];
  for (
    let e: unknown = error;
    e instanceof Error && !chain.includes(e);
    e = e.cause
  ) {
    chain.push(e);
  }
  return chain;
}

/** An error that names its kind: a SQLSTATE from Postgres, an errno name from Node. */
export type CodedError = Error & { code: string; constraint?: unknown };

/**
 * The driver's error in `error`'s chain: the innermost with a string `code`.
 * Drizzle wraps node-postgres's error as the `cause` of one whose message is
 * the failed statement (DrizzleQueryError), so the reason and its SQLSTATE
 * sit at the bottom; a socket failure under it carries Node's errno name
 * (ECONNREFUSED) the same way.
 */
export function driverError(error: unknown): CodedError | undefined {
  if (!(error instanceof Error)) return undefined;
  const chain = causeChain(error);
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const { code } = chain[i] as Error & { code?: unknown };
    if (typeof code === 'string') return chain[i] as CodedError;
  }
  return undefined;
}
