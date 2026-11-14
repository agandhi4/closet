import { type Config, ConfigError, loadConfig } from '../config';
import {
  createDb,
  type Db,
  dbConfig,
  MAINTENANCE_TIMEOUTS,
} from '../db/client';
import { requireCurrentSchema, SchemaBehindError } from '../db/migrate';
import { createBootLogger, createLogger, type Logger } from '../logger';
import { configurePasswordHashing } from '../web/auth/passwords';
import { StorageIdentityError } from '../web/files/storage-identity';

export interface CliContext {
  config: Config;
  /** The command's own child logger (named `name`). */
  logger: Logger;
  db: Db;
  /**
   * Aborted by the first SIGINT or SIGTERM when the command is `stoppable`
   * (never otherwise): it finishes the unit of work in flight, stops, and
   * resolves to STOPPED_STATUS. A second signal kills the process as usual.
   */
  stop: AbortSignal;
}

export interface CliOptions {
  /**
   * The command works in units it can stop between (the thumb retrim's
   * photos): a signal is its `stop`, not the end of the process, so no unit
   * is cut off between storing its files and the row pointing at them.
   * Without it a signal ends the process at once, as Node does (set-password
   * waiting on a prompt must still die on Ctrl-C).
   */
  stoppable?: boolean;
}

/** The exit status of a stoppable command stopped by a signal: 128 + SIGINT, the shell's convention. */
export const STOPPED_STATUS = 130;

const STOP_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/**
 * A command's `stop` (runCli passes `process` as `signals`): never aborted
 * unless `stoppable`, then aborted by the first SIGINT or SIGTERM, with a
 * warn line. That signal takes both handlers away, so a second one, either
 * of them, finds none and ends the process as Node does.
 */
export function commandStop(
  { stoppable = false }: CliOptions,
  signals: Pick<NodeJS.EventEmitter, 'on' | 'removeListener'>,
  logger: Logger,
): AbortSignal {
  const stop = new AbortController();
  if (!stoppable) return stop.signal;
  // Node calls a signal's listeners with the signal's name.
  const onSignal = (signal: NodeJS.Signals) => {
    for (const each of STOP_SIGNALS) signals.removeListener(each, onSignal);
    logger.warn(
      `${signal}: finishing the work in flight, then stopping (again to kill)`,
    );
    stop.abort();
  };
  for (const signal of STOP_SIGNALS) signals.on(signal, onSignal);
  return stop.signal;
}

/**
 * The frame of a maintenance command (reconcile.cli.ts,
 * set-password.cli.ts, revoke-push.cli.ts, retrim-thumbs.cli.ts): the
 * server's configuration and logger, a database this build's migrations
 * have fully reached (the CLIs never migrate; see requireCurrentSchema), the
 * command, then the pool closed. The command resolves to the exit status;
 * anything it throws is exit status 1 with the reason as a fatal line (the
 * boot logger's: the failure may be the configuration the command's own
 * logger needs). Runs from dist/ in the production image with the
 * container's own environment (`docker exec closet npm run ...`).
 */
export function runCli(
  name: string,
  command: (context: CliContext) => Promise<number>,
  options: CliOptions = {},
): void {
  run(name, command, options).then(
    (status) => {
      process.exitCode = status;
    },
    (error: unknown) => {
      const boot = createBootLogger();
      // Refusals name their reason; anything else is logged with its stack.
      if (
        error instanceof ConfigError ||
        error instanceof SchemaBehindError ||
        error instanceof StorageIdentityError
      ) {
        boot.fatal(`${name}: ${error.message}`);
      } else {
        boot.fatal({ err: error }, `${name} failed`);
      }
      process.exitCode = 1;
    },
  );
}

async function run(
  name: string,
  command: (context: CliContext) => Promise<number>,
  options: CliOptions,
): Promise<number> {
  const config = loadConfig();
  const logger = createLogger(config);
  // As the server: a password the CLI sets costs what a sign-in compares.
  configurePasswordHashing(config.PASSWORD_HASH_ROUNDS);
  await requireCurrentSchema(dbConfig(config));
  // Operator-scale work (a seeded persona is one transaction): the long
  // timeouts, not the server's.
  const db = createDb(dbConfig(config), logger.child({ logger: 'Db' }), {
    timeouts: MAINTENANCE_TIMEOUTS,
  });
  const commandLogger = logger.child({ logger: name });
  try {
    return await command({
      config,
      logger: commandLogger,
      db,
      stop: commandStop(options, process, commandLogger),
    });
  } finally {
    await db.$client.end();
  }
}
