import { type Config, ConfigError, loadConfig } from '../config';
import { createBootLogger, createLogger } from '../logger';
import { BIREFNET_512, CutoutModel } from './model';

/**
 * `npm run cutout:fetch-model`: puts the background-removal model into MODELS_PATH
 * (download, checksum, rename) or verifies the one already there, then
 * exits: 0 ready, 1 failed. A file that fails the checksum is replaced
 * (the server downloads a missing model at boot but only refuses a
 * mismatched one): `docker exec closet npm run cutout:fetch-model`. Needs the server's
 * configuration (loadConfig checks all of it) but no database.
 */
function main(): void {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    const boot = createBootLogger();
    if (error instanceof ConfigError) boot.fatal(error.message);
    else boot.fatal({ err: error }, 'Configuration failed to load');
    process.exitCode = 1;
    return;
  }
  const logger = createLogger(config).child({ logger: 'CutoutModel' });
  new CutoutModel(BIREFNET_512, config.MODELS_PATH, logger)
    .ready({ replaceMismatched: true })
    .then(
      (path) => {
        // The command's result, for a script to read (not a log line: the
        // details went to the log).
        process.stdout.write(`${path}\n`);
      },
      (error: unknown) => {
        logger.fatal({ err: error }, 'The model is not ready');
        process.exitCode = 1;
      },
    );
}

main();
