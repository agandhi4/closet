import type { FastifyInstance } from 'fastify';
import { type AppOptions, createApp } from './app';
import type { Config } from './config';
import { type CutoutQueue, retryFailedCutouts } from './cutout/queue';
import type { CutoutRunner } from './cutout/runner';
import type { Db } from './db/client';
import type { Logger } from './logger';
import type { Metrics } from './metrics/metrics';
import { scheduleMinutely } from './maintenance/minutely';
import { scheduleNightly } from './maintenance/nightly';
import { reconcileStorage } from './maintenance/reconcile';
import { type ScheduledJob, stopBeforeClose } from './maintenance/scheduled';
import { addDays, todayIn } from './web/calendar/calendar-date';
import { pruneReminders, sendDueReminders } from './web/push/reminders';
import type { PushSender } from './web/push/sender';
import {
  pruneReplans,
  type ReplanDeps,
  replanWeeks,
} from './web/week-plan/replan';

// The hour, in APP_TIMEZONE, of the nightly storage reconciliation and the
// cutout retry.
const RECONCILE_HOUR = 3;

/**
 * The server process: createApp(), the nightly jobs, the push reminders
 * (with PWA_ENABLED), the week's daily re-plan (the planner's entries
 * judged against the forecast with WEATHER_ENABLED, and always against
 * what can still be worn), the background-removal queue started with
 * `runner`,
 * signal handling, listen. main.ts passes the model (ModelRunner);
 * test/support/test-server.ts, which Playwright, the load test and
 * Lighthouse boot on the build, passes a stub, so no test downloads or runs
 * the 940 MB model. createApp() itself never starts the queue or a timer:
 * the integration harness and the CLIs never run jobs or send anything.
 * `options` are createApp's test-only ones (the test server's stand-in for
 * Open-Meteo); main.ts passes none. Returns the listening app, so a caller
 * that started something beside it (the test server's stub) can stop it
 * when the app's server closes.
 */
export async function serve(
  config: Config,
  logger: Logger,
  runner: CutoutRunner,
  options: AppOptions = {},
): Promise<FastifyInstance> {
  const { app, db, photos, cutouts, push, weather, metrics } = await createApp(
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
        run: metrics.timeJob('reconciliation', () =>
          reconcileStorage({ db, photos, logger: reconciliation }),
        ),
        logger: reconciliation,
      }),
    );
  } else {
    reconciliation.info(
      'Storage reconciliation disabled (MAINTENANCE_ENABLED=false)',
    );
  }
  jobs.push(startCutouts(config, logger, metrics, db, cutouts, runner));
  // One set of re-plan deps: the minutely run and the morning reminder's
  // re-plan first (src/web/push/reminders.ts) are the same re-plan.
  const replan: ReplanDeps = {
    db,
    weather,
    push,
    timeZone: config.APP_TIMEZONE,
    logger: logger.child({ context: 'WeekPlan' }),
  };
  if (push) {
    jobs.push(...startReminders(config, logger, metrics, push, replan));
  }
  jobs.push(...startReplans(config, metrics, replan));
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
  return app;
}

// The queue (pending cutouts from before a restart first; createApp stops
// it) and the nightly retry of failed ones, returned.
function startCutouts(
  config: Config,
  logger: Logger,
  metrics: Metrics,
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
    run: metrics.timeJob('cutout_retry', async () => {
      if ((await retryFailedCutouts(db, log)) > 0) cutouts.wake();
    }),
    logger: log,
  });
}

// The push reminders (src/web/push/reminders.ts): every minute, what is due
// is claimed and sent (a morning one after its person's re-plan); the claims
// of past days go nightly. Both returned.
function startReminders(
  config: Config,
  logger: Logger,
  metrics: Metrics,
  sender: PushSender,
  replan: ReplanDeps,
): ScheduledJob[] {
  const log = logger.child({ context: 'Push' });
  const deps = {
    db: replan.db,
    sender,
    weather: replan.weather,
    timeZone: config.APP_TIMEZONE,
    logger: log,
    replan,
  };
  const reminders = scheduleMinutely({
    name: 'Push reminders',
    run: metrics.timeJob('reminders', (now: Date) =>
      sendDueReminders(deps, now),
    ),
    logger: log,
  });
  const prune = scheduleNightly({
    name: 'Reminder claims prune',
    hour: RECONCILE_HOUR,
    timeZone: config.APP_TIMEZONE,
    run: metrics.timeJob('reminder_prune', () =>
      pruneReminders(
        deps,
        addDays(todayIn(config.APP_TIMEZONE, new Date()), -1),
      ),
    ),
    logger: log,
  });
  return [reminders, prune];
}

// The week's daily re-plan (src/web/week-plan/replan.ts): every minute a
// run that does nothing before REPLAN_HOUR and then re-plans each user due
// one, once for the day (so a restart after the hour catches up); the
// claims of past days go nightly. Both returned. Scheduled with or without
// WEATHER_ENABLED: without a forecast it still swaps an outfit that can no
// longer be worn.
function startReplans(
  config: Config,
  metrics: Metrics,
  deps: ReplanDeps,
): ScheduledJob[] {
  const replans = scheduleMinutely({
    name: 'Week re-plan',
    run: metrics.timeJob('replan', (now: Date) => replanWeeks(deps, now)),
    logger: deps.logger,
  });
  const prune = scheduleNightly({
    name: 'Re-plan claims prune',
    hour: RECONCILE_HOUR,
    timeZone: config.APP_TIMEZONE,
    run: metrics.timeJob('replan_prune', () =>
      pruneReplans(deps, addDays(todayIn(config.APP_TIMEZONE, new Date()), -1)),
    ),
    logger: deps.logger,
  });
  return [replans, prune];
}
