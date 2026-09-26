import type { FastifyInstance } from 'fastify';
import { createApp } from './app';
import type { Config } from './config';
import { type CutoutQueue, retryFailedCutouts } from './cutout/queue';
import type { CutoutRunner } from './cutout/runner';
import type { Db } from './db/client';
import type { Logger } from './logger';
import { scheduleNightly } from './maintenance/nightly';
import { reconcileStorage } from './maintenance/reconcile';

// The hour, in APP_TIMEZONE, of the nightly storage reconciliation and the
// cutout retry.
const RECONCILE_HOUR = 3;

/**
 * The server process: createApp(), the nightly jobs, the background-removal
 * queue started with `runner`, signal handling, listen. main.ts passes the
 * model (ModelRunner); test/support/test-server.ts, which Playwright, the
 * load test and Lighthouse boot on the build, passes a stub, so no test
 * downloads or runs the 940 MB model. createApp() itself never starts the
 * queue or a timer: the integration harness and the CLIs never run jobs.
 */
export async function serve(
  config: Config,
  logger: Logger,
  runner: CutoutRunner,
): Promise<void> {
  const { app, db, photos, cutouts } = await createApp(config, logger);

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
  startCutouts(config, logger, app, db, cutouts, runner);

  // `docker stop` sends SIGTERM: stop accepting, let in-flight requests
  // finish, then onClose ends the queue, the pool and the timers and the
  // process exits on its own.
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

// The queue (pending cutouts from before a restart first) and the nightly
// retry of failed ones.
function startCutouts(
  config: Config,
  logger: Logger,
  app: FastifyInstance,
  db: Db,
  cutouts: CutoutQueue,
  runner: CutoutRunner,
): void {
  const log = logger.child({ context: 'Cutout' });
  cutouts.start(runner);
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
