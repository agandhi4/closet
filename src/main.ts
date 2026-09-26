import { createApp } from './app';
import { type Config, ConfigError, loadConfig } from './config';
import { createLogger, type Logger } from './logger';
import { scheduleNightly } from './maintenance/nightly';
import { reconcileStorage } from './maintenance/reconcile';

// The hour, in APP_TIMEZONE, of the nightly storage reconciliation.
const RECONCILE_HOUR = 3;

async function serve(config: Config, logger: Logger): Promise<void> {
  const { app, db, photos } = await createApp(config, logger);

  // The server is the only process that schedules it: the integration
  // harness and the CLIs never hold a timer.
  const reconciliation = logger.child({ context: 'Reconciliation' });
  if (config.MAINTENANCE_ENABLED) {
    const nightly = scheduleNightly({
      name: 'Storage reconciliation',
      hour: RECONCILE_HOUR,
      timeZone: config.APP_TIMEZONE,
      run: () => reconcileStorage({ db, photos, logger: reconciliation }),
      logger: reconciliation,
    });
    // Before listen(): Fastify takes no hooks once it is ready.
    app.addHook('onClose', (_instance, done) => {
      nightly.stop();
      done();
    });
  } else {
    reconciliation.info(
      'Storage reconciliation disabled (MAINTENANCE_ENABLED=false)',
    );
  }

  // `docker stop` sends SIGTERM: stop accepting, let in-flight requests
  // finish, then onClose ends the pool and the timer and the process exits
  // on its own.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      logger.info(`${signal}: shutting down`);
      app.close().catch((error: unknown) => {
        logger.error({ err: error }, 'Shutdown failed');
        process.exitCode = 1;
      });
    });
  }

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
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
  serve(config, logger).catch((error: unknown) => {
    logger.fatal({ err: error }, 'Boot failed');
    process.exit(1);
  });
}

main();
