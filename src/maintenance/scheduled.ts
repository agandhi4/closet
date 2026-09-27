import type { FastifyInstance } from 'fastify';
import { settlesWithin } from '../cutout/deadline';
import type { Logger } from '../logger';

/**
 * What every timer server.ts starts has in common (scheduleNightly,
 * scheduleMinutely): stop() clears the pending timer, so no run starts
 * after it, and resolves once a run in flight has ended, or after
 * STOP_WAIT_MS with a warning (awaitRunInFlight). It never rejects.
 */
export interface ScheduledJob {
  stop(): Promise<void>;
}

/**
 * How long stop() waits for a run in flight: past a push send's 10 s socket
 * timeout per device, and short of a deploy's patience. A run cut off here
 * keeps going until its next query fails against the ended pool; every
 * scheduled job leaves the database consistent at each step (claims before
 * work, rows before bytes), so what it did not finish is found next time.
 */
export const STOP_WAIT_MS = 15_000;

/** Waits for `running` (a run's promise, which never rejects), at most STOP_WAIT_MS. */
export async function awaitRunInFlight(
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
