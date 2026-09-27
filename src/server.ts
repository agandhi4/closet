import { type AppOptions, createApp } from './app';
import type { Config } from './config';
import { type CutoutQueue, retryFailedCutouts } from './cutout/queue';
import type { CutoutRunner } from './cutout/runner';
import type { Db } from './db/client';
import type { Logger } from './logger';
import { scheduleMinutely } from './maintenance/minutely';
import { scheduleNightly } from './maintenance/nightly';
import { reconcileStorage } from './maintenance/reconcile';
import { type ScheduledJob, stopBeforeClose } from './maintenance/scheduled';
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

  // Every timer, stopped together at preClose (a run in flight waited for)
  // before onClose ends the queue and the pool (#78).
  const jobs: ScheduledJob[] = [];
  const reconciliation = logger.child({ context: 'Reconciliation' });
  if (config.MAINTENANCE_ENABLED) {
    jobs.push(
      scheduleNightly({
        name: 'Storage reconciliation',
        hour: RECONCILE_HOUR,
        timeZone: config.APP_TIMEZONE,
        run: () => reconcileStorage({ db, photos, logger: reconciliation }),
        logger: reconciliation,
      }),
    );
  } else {
    reconciliation.info(
      'Storage reconciliation disabled (MAINTENANCE_ENABLED=false)',
    );
  }
  jobs.push(startCutouts(config, logger, db, cutouts, runner));
  if (push) jobs.push(...startReminders(config, logger, db, push, weather));
  if (weather) jobs.push(...startReplans(config, logger, db, weather, push));
  // Before listen(): Fastify takes no hooks once it is ready.
  stopBeforeClose(app, jobs, logger.child({ context: 'Scheduler' }));

  // `docker stop` sends SIGTERM: stop accepting, let in-flight requests
  // finish and stop the timers (preClose), then onClose ends the queue and
  // the pool and the process exits on its own.
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

// The queue (pending cutouts from before a restart first; createApp stops
// it) and the nightly retry of failed ones, returned.
function startCutouts(
  config: Config,
  logger: Logger,
  db: Db,
  cutouts: CutoutQueue,
  runner: CutoutRunner,
): ScheduledJob {
  const log = logger.child({ context: 'Cutout' });
  cutouts.start(runner);
  return scheduleNightly({
    name: 'Cutout retry',
    hour: RECONCILE_HOUR,
    timeZone: config.APP_TIMEZONE,
    run: async () => {
      if ((await retryFailedCutouts(db, log)) > 0) cutouts.wake();
    },
    logger: log,
  });
}

// The push reminders (src/web/push/reminders.ts): every minute, what is due
// is claimed and sent; the claims of past days go nightly. Both returned.
function startReminders(
  config: Config,
  logger: Logger,
  db: Db,
  sender: PushSender,
  weather: WeatherService | undefined,
): ScheduledJob[] {
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
  return [reminders, prune];
}

// The week's daily re-plan (src/web/week-plan/replan.ts): every minute a
// run that does nothing before REPLAN_HOUR and then claims each user's
// re-plan once for the day (so a restart after the hour catches up); the
// claims of past days go nightly. Both returned. Without WEATHER_ENABLED
// there is no forecast to re-plan against, so nothing is scheduled.
function startReplans(
  config: Config,
  logger: Logger,
  db: Db,
  weather: WeatherService,
  push: PushSender | undefined,
): ScheduledJob[] {
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
  return [replans, prune];
}
