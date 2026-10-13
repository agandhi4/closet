import { type Config, ConfigError, loadConfig } from './config';
import { BIREFNET_512, CutoutModel } from './cutout/model';
import { ModelRunner } from './cutout/runner';
import { createBootLogger, createLogger, type Logger } from './logger';
import { createCrashHandler } from './metrics/error-tracker';
import { serve } from './server';

/**
 * The background-removal model's runner. The model file is verified (or
 * downloaded) now, at boot, rather than at the first upload; the process
 * that runs it starts with the first job.
 */
function modelRunner(config: Config, logger: Logger): ModelRunner {
  const log = logger.child({ logger: 'Cutout' });
  log.info(
    `Background removal: model in ${config.MODELS_PATH}, ${config.CUTOUT_THREADS} threads`,
  );
  const model = new CutoutModel(
    BIREFNET_512,
    config.MODELS_PATH,
    logger.child({ logger: 'CutoutModel' }),
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
// reports it. The logger loses no line: JSON is written synchronously, and
// the text format's worker flushes on exit (src/logger.ts).
//
// Once serving, a crash (an uncaught exception, or an unhandled rejection,
// which Node raises as one) is sent to the error tracker before the
// process exits 1 as it would have (createCrashHandler). Here only, never
// in createApp: the specs' processes boot many apps and keep Node's own.
function main(): void {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    // A ConfigError names the bad keys (never their values); anything else
    // is a bug, logged with its stack.
    const boot = createBootLogger();
    if (error instanceof ConfigError) boot.fatal(error.message);
    else boot.fatal({ err: error }, 'Configuration failed to load');
    process.exit(1);
  }
  const logger = createLogger(config);
  serve(config, logger, modelRunner(config, logger))
    .then(({ errors }) => {
      const onCrash = createCrashHandler({
        errors,
        logger,
        exit: (code) => process.exit(code),
      });
      process.on('uncaughtException', (error, origin) => {
        void onCrash(error, origin);
      });
    })
    .catch((error: unknown) => {
      logger.fatal({ err: error }, 'Boot failed');
      process.exit(1);
    });
}

main();
