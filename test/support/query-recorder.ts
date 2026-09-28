import { Client, type QueryResult } from 'pg';

/**
 * Every SQL statement the process sends while `work` runs, with the rows it
 * returned and how long it took. The app's pool goes through node-postgres's
 * Client class, so wrapping Client.prototype.query sees every statement of an
 * app running in this process: the integration harness's recordQueries
 * (test/integration/harness.ts) and the page audit (scripts/audit/) record
 * through it. Nothing in the app changes: the wrapper exists only while
 * `work` runs, in the process that asked.
 *
 * One recording at a time: statements are not attributed to a caller, so a
 * second recording would count the first's.
 */

export interface RecordedStatement {
  /** The SQL text as sent (Drizzle's parameterised `$1` form). */
  sql: string;
  /** Its parameters, for replaying it under EXPLAIN. */
  values: readonly unknown[];
  /** Rows it returned (0 for a write without RETURNING, or a failure). */
  rows: number;
  /** From the call to its answer: queueing on the connection included. */
  ms: number;
}

type QueryCallback = (error: Error | null, result?: QueryResult) => void;

let recording = false;

export async function recordStatements<T>(
  work: () => Promise<T>,
): Promise<{ result: T; statements: RecordedStatement[] }> {
  if (recording) {
    throw new Error('recordStatements does not nest: one recording at a time');
  }
  const statements: RecordedStatement[] = [];
  // The original, called below with the Client the app called it on.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const query = Client.prototype.query;
  // Client.query is overloaded (promise, callback, Submittable); the wrapper
  // forwards whatever it is given, so it is typed as the original.
  const wrapped = function (this: Client, ...args: unknown[]): unknown {
    // A query is a string or a config object ({ text, values }: Drizzle's).
    const [config, second] = args;
    const text =
      typeof config === 'string'
        ? config
        : (config as { text?: unknown } | undefined)?.text;
    const configValues = (config as { values?: unknown } | undefined)?.values;
    const values = Array.isArray(second)
      ? second
      : Array.isArray(configValues)
        ? configValues
        : [];
    const statement: RecordedStatement = {
      sql: typeof text === 'string' ? text : '',
      values,
      rows: 0,
      ms: 0,
    };
    statements.push(statement);
    const started = performance.now();
    const settle = (result: QueryResult | undefined) => {
      statement.ms = performance.now() - started;
      statement.rows = result?.rows?.length ?? 0;
    };
    const callback = args.at(-1);
    if (typeof callback === 'function') {
      args[args.length - 1] = ((error, result) => {
        settle(result);
        (callback as QueryCallback)(error, result);
      }) satisfies QueryCallback;
    }
    const returned: unknown = Reflect.apply(query, this, args);
    if (returned instanceof Promise) {
      return returned.then(
        (result: QueryResult) => {
          settle(result);
          return result;
        },
        (error: Error) => {
          settle(undefined);
          throw error;
        },
      );
    }
    return returned;
  };
  recording = true;
  Client.prototype.query = wrapped as typeof Client.prototype.query;
  try {
    const result = await work();
    return { result, statements };
  } finally {
    Client.prototype.query = query;
    recording = false;
  }
}
