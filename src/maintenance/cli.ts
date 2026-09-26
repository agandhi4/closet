import { type Config, ConfigError, loadConfig } from '../config';
import { createDb, type Db, dbConfig } from '../db/client';
import { requireCurrentSchema, SchemaBehindError } from '../db/migrate';
import { createLogger, type Logger } from '../logger';

export interface CliContext {
  config: Config;
  /** The command's own child logger (context `name`). */
  logger: Logger;
  db: Db;
}

/**
 * The frame of a maintenance command (reconcile.cli.ts,
 * set-password.cli.ts): the server's configuration and logger, a database
 * this build's migrations have fully reached (the CLIs never migrate; see
 * requireCurrentSchema), the command, then the pool closed. The command
 * resolves to the exit status; anything it throws is exit status 1 with the
 * reason on stderr. Runs from dist/ in the production image with the
 * container's own environment (`docker exec closet npm run ...`).
 */
export function runCli(
  name: string,
  command: (context: CliContext) => Promise<number>,
): void {
  run(name, command).then(
    (status) => {
      process.exitCode = status;
    },
    (error: unknown) => {
      console.error(
        error instanceof ConfigError || error instanceof SchemaBehindError
          ? error.message
          : error,
      );
      process.exitCode = 1;
    },
  );
}

async function run(
  name: string,
  command: (context: CliContext) => Promise<number>,
): Promise<number> {
  const config = loadConfig();
  const logger = createLogger(config);
  await requireCurrentSchema(dbConfig(config));
  const db = createDb(dbConfig(config), logger.child({ context: 'Db' }));
  try {
    return await command({
      config,
      logger: logger.child({ context: name }),
      db,
    });
  } finally {
    await db.$client.end();
  }
}
