import { type Config, ConfigError, loadConfig } from './config';
import { BIREFNET_512, CutoutModel } from './cutout/model';
import { ModelRunner } from './cutout/runner';
import { createLogger, type Logger } from './logger';
import { serve } from './server';

/**
 * The background-removal model's runner. The model file is verified (or
 * downloaded) now, at boot, rather than at the first upload; the process
 * that runs it starts with the first job.
 */
function modelRunner(config: Config, logger: Logger): ModelRunner {
  const log = logger.child({ context: 'Cutout' });
  log.info(
    `Background removal: model in ${config.MODELS_PATH}, ${config.CUTOUT_THREADS} threads`,
  );
  const model = new CutoutModel(
    BIREFNET_512,
    config.MODELS_PATH,
    logger.child({ context: 'CutoutModel' }),
  );
  // Logged by CutoutModel; the first job tries again if this failed.
  model.ready().catch(() => undefined);
  return new ModelRunner({
    model,
    threads: config.CUTOUT_THREADS,
    logger: log,
  });
}

// A boot that fails (bad configuration, a refused migration, a taken port)
// ends the process, whatever still holds the event loop, so the container
// reports it. pino's transport flushes on exit.
function main(): void {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : error);
    process.exit(1);
  }
  const logger = createLogger(config);
  serve(config, logger, modelRunner(config, logger)).catch((error: unknown) => {
    logger.fatal({ err: error }, 'Boot failed');
    process.exit(1);
  });
}

main();
