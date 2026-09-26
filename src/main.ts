import type { FastifyInstance } from 'fastify';
import { createApp } from './app';
import { type Config, ConfigError, loadConfig } from './config';
import { BIREFNET_512, CutoutModel } from './cutout/model';
import { type CutoutQueue, retryFailedCutouts } from './cutout/queue';
import { ModelRunner } from './cutout/runner';
import type { Db } from './db/client';
import { createLogger, type Logger } from './logger';
import { scheduleNightly } from './maintenance/nightly';
import { reconcileStorage } from './maintenance/reconcile';

// The hour, in APP_TIMEZONE, of the nightly storage reconciliation and the
// cutout retry.
const RECONCILE_HOUR = 3;

/**
 * CUTOUT_MODE=server: the model (verified, or downloaded, now rather than
 * at the first upload), the queue started with it (pending cutouts from
 * before a restart first), and the nightly retry of failed ones. Only the
 * server does this; createApp() never starts the queue.
 */
function startServerCutouts(
  config: Config,
  logger: Logger,
  app: FastifyInstance,
  db: Db,
  cutouts: CutoutQueue,
): void {
  const log = logger.child({ context: 'Cutout' });
  const model = new CutoutModel(
    BIREFNET_512,
    config.MODELS_PATH,
    logger.child({ context: 'CutoutModel' }),
  );
  // Logged by CutoutModel; the first job tries again if this failed.
  model.ready().catch(() => undefined);
  cutouts.start(
    new ModelRunner({ model, threads: config.CUTOUT_THREADS, logger: log }),
  );
  const retry = scheduleNightly({
    name: 'Cutout retry',
    hour: RECONCILE_HOUR,
    timeZone: config.APP_TIMEZONE,
    run: async () => {
      if ((await retryFailedCutouts(db, log)) > 0) cutouts.wake();
    },
    logger: log,
  });
  app.addHook('onClose', (_instance, done) => {
    retry.stop();
    done();
  });
}

async function serve(config: Config, logger: Logger): Promise<void> {
  const { app, db, photos, cutouts } = await createApp(config, logger);

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
  // Before listen() too (hooks).
  if (config.CUTOUT_MODE === 'server') {
    startServerCutouts(config, logger, app, db, cutouts);
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
