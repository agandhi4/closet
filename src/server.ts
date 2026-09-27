import type { FastifyInstance } from 'fastify';
import { type AppOptions, createApp } from './app';
import type { Config } from './config';
import { type CutoutQueue, retryFailedCutouts } from './cutout/queue';
import type { CutoutRunner } from './cutout/runner';
import type { Db } from './db/client';
import type { Logger } from './logger';
import { scheduleMinutely } from './maintenance/minutely';
import { scheduleNightly } from './maintenance/nightly';
import { reconcileStorage } from './maintenance/reconcile';
import { addDays, todayIn } from './web/calendar/calendar-date';
import { pruneReminders, sendDueReminders } from './web/push/reminders';
import type { PushSender } from './web/push/sender';
import type { WeatherService } from './web/weather/service';
import { pruneReplans, replanWeeks } from './web/week-plan/replan';

// The hour, in APP_TIMEZONE, of the nightly storage reconciliation and the
// cutout retry.
const RECONCILE_HOUR = 3;

/**
 * The server process: createApp(), the nightly jobs, the push reminders
 * (with PWA_ENABLED), the week's daily re-plan (with WEATHER_ENABLED: it
 * judges the planner's entries against the forecast), the
 * background-removal queue started with `runner`,
 * signal handling, listen. main.ts passes the model (ModelRunner);
 * test/support/test-server.ts, which Playwright, the load test and
 * Lighthouse boot on the build, passes a stub, so no test downloads or runs
 * the 940 MB model. createApp() itself never starts the queue or a timer:
 * the integration harness and the CLIs never run jobs or send anything.
 * `options` are createApp's test-only ones (the test server's stand-in for
 * Open-Meteo); main.ts passes none.
 */
export async function serve(
  config: Config,
  logger: Logger,
  runner: CutoutRunner,
  options: AppOptions = {},
): Promise<void> {
  const { app, db, photos, cutouts, push, weather } = await createApp(
    config,
    logger,
    options,
  );

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
  if (push) startReminders(config, logger, app, db, push, weather);
  if (weather) startReplans(config, logger, app, db, weather, push);

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

// The push reminders (src/web/push/reminders.ts): every minute, what is due
// is claimed and sent; the claims of past days go nightly. Stopped before
// the server closes, waiting for a run in flight (it uses the pool).
function startReminders(
  config: Config,
  logger: Logger,
  app: FastifyInstance,
  db: Db,
  sender: PushSender,
  weather: WeatherService | undefined,
): void {
  const log = logger.child({ context: 'Push' });
  const deps = {
    db,
    sender,
    weather,
    timeZone: config.APP_TIMEZONE,
    logger: log,
  };
  const reminders = scheduleMinutely({
    name: 'Push reminders',
    run: (now) => sendDueReminders(deps, now),
    logger: log,
  });
  const prune = scheduleNightly({
    name: 'Reminder claims prune',
    hour: RECONCILE_HOUR,
    timeZone: config.APP_TIMEZONE,
    run: () =>
      pruneReminders(
        deps,
        addDays(todayIn(config.APP_TIMEZONE, new Date()), -1),
      ),
    logger: log,
  });
  app.addHook('preClose', async () => {
    prune.stop();
    await reminders.stop();
  });
}

// The week's daily re-plan (src/web/week-plan/replan.ts): every minute a
// run that does nothing before REPLAN_HOUR and then claims each user's
// re-plan once for the day (so a restart after the hour catches up); the
// claims of past days go nightly. Stopped before the server closes, waiting
// for a run in flight (it uses the pool). Without WEATHER_ENABLED there is
// no forecast to re-plan against, so nothing is scheduled.
function startReplans(
  config: Config,
  logger: Logger,
  app: FastifyInstance,
  db: Db,
  weather: WeatherService,
  push: PushSender | undefined,
): void {
  const log = logger.child({ context: 'WeekPlan' });
  const deps = {
    db,
    weather,
    push,
    timeZone: config.APP_TIMEZONE,
    logger: log,
  };
  const replans = scheduleMinutely({
    name: 'Week re-plan',
    run: (now) => replanWeeks(deps, now),
    logger: log,
  });
  const prune = scheduleNightly({
    name: 'Re-plan claims prune',
    hour: RECONCILE_HOUR,
    timeZone: config.APP_TIMEZONE,
    run: () =>
      pruneReplans(deps, addDays(todayIn(config.APP_TIMEZONE, new Date()), -1)),
    logger: log,
  });
  app.addHook('preClose', async () => {
    prune.stop();
    await replans.stop();
  });
}
