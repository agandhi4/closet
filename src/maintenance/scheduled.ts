import type { FastifyInstance } from 'fastify';
import { settlesWithin } from '../cutout/deadline';
import type { Logger } from '../logger';
import { runAsJob } from '../request-context';

/**
 * What every timer server.ts starts has in common (scheduleNightly,
 * scheduleMinutely): stop() clears the pending timer, so no run starts
 * after it, and resolves once a run in flight has ended, or after
 * STOP_WAIT_MS with a warning (awaitRunInFlight). It never rejects.
 */
export interface ScheduledJob {
  /** The name it logs under; JobRoster reports a stuck job by it. */
  readonly name: string;
  /**
   * When the run in flight started (epoch ms), undefined between runs.
   * The next run is scheduled only once a run ends, so a run that never
   * settles is the one way a job silently stops: JobRoster watches this.
   */
  runStartedAt(): number | undefined;
  stop(): Promise<void>;
}

/**
 * A run in flight longer than this is reported stuck by /health/ready.
 * Far past any honest run: the minute jobs take seconds (a push send's
 * socket timeout is 10 s a device), the nightly ones household-sized
 * queries and one storage walk.
 */
export const STUCK_AFTER_MS = 30 * 60_000;

/**
 * The jobs this process schedules, for /health/ready (src/web/health).
 * createApp() builds it empty and hands it to the web layer; serve() adopts
 * every job it started, once, beside stopBeforeClose. Never adopted means
 * this process schedules nothing: the integration harness and the CLIs
 * build the app without serve(). serve() starting a job and then throwing
 * ends the process (main.ts), so the adopted list is the expected one.
 */
export class JobRoster {
  private jobs: readonly ScheduledJob[] | undefined;

  adopt(jobs: readonly ScheduledJob[]): void {
    if (this.jobs) throw new Error('The job roster was already adopted');
    this.jobs = jobs;
  }

  /**
   * The names of the jobs whose run has been in flight past STUCK_AFTER_MS
   * at `now`; undefined when nothing was adopted.
   */
  stuck(now: number = Date.now()): string[] | undefined {
    return this.jobs
      ?.filter((job) => {
        const started = job.runStartedAt();
        return started !== undefined && now - started > STUCK_AFTER_MS;
      })
      .map((job) => job.name);
  }
}

/**
 * How long stop() waits for a run in flight: past a push send's 10 s socket
 * timeout per device, and short of a deploy's patience. A run cut off here
 * keeps going until its next query fails against the ended pool; every
 * scheduled job leaves the database consistent at each step (claims before
 * work, rows before bytes), so what it did not finish is found next time.
 */
const STOP_WAIT_MS = 15_000;

export interface JobTimer {
  name: string;
  logger: Logger;
  now: () => Date;
  /** Milliseconds until the next run, asked afresh once the last run ended. */
  untilNext: () => number;
  run: () => Promise<unknown>;
}

/**
 * The timer loop behind scheduleNightly and scheduleMinutely, which bring
 * only when the next run is: the next run is scheduled once the last one
 * ended, from the clock as it is then, so a slow run never overlaps the
 * next and never drifts it. Each run is one job (a fresh `cron-` id on
 * every line it logs, its failure line included), never one per timer.
 */
export function scheduleJob({
  name,
  logger,
  now,
  untilNext,
  run,
}: JobTimer): ScheduledJob {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let runStartedAt: number | undefined;
  let stopped = false;

  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(tick, untilNext());
    // Never what keeps the process alive: the server's socket does that.
    timer.unref();
  };

  // `running` is set synchronously with the timer firing, so a stop() that
  // lands at any point after it sees the run.
  const tick = () => {
    runStartedAt = now().getTime();
    running = runAsJob('cron', async () => {
      try {
        await run();
      } catch (error) {
        // Logged, never thrown: a failed run must not stop the next one.
        logger.error({ err: error }, `${name} failed`);
      }
    });
    void running.then(() => {
      running = undefined;
      runStartedAt = undefined;
      scheduleNext();
    });
  };

  scheduleNext();
  return {
    name,
    runStartedAt: () => runStartedAt,
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await awaitRunInFlight(name, running, logger);
    },
  };
}

/** Waits for `running` (a run's promise, which never rejects), at most STOP_WAIT_MS. */
async function awaitRunInFlight(
  name: string,
  running: Promise<void> | undefined,
  logger: Logger,
): Promise<void> {
  if (running && !(await settlesWithin(running, STOP_WAIT_MS))) {
    logger.warn(`${name} still running after ${STOP_WAIT_MS} ms; stopped`);
  }
}

/**
 * Stops every job at `preClose`, together, before any onClose hook runs:
 * createApp's ends the pool, and a run in flight still needs it. The one
 * place server.ts's timers are stopped, so a new one cannot miss the rule.
 * Register before listen() (Fastify takes no hooks once it is ready).
 */
export function stopBeforeClose(
  app: FastifyInstance,
  jobs: readonly ScheduledJob[],
  logger: Logger,
): void {
  app.addHook('preClose', async () => {
    const started = Date.now();
    await Promise.all(jobs.map((job) => job.stop()));
    logger.info(
      `Stopped ${jobs.length} scheduled jobs in ${Date.now() - started} ms`,
    );
  });
}
