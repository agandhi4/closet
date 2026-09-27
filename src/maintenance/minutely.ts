import { settlesWithin } from '../cutout/deadline';
import type { Logger } from '../logger';

/**
 * A job at the start of every minute (a second past it, so a 07:30 reminder
 * is due when it runs at 07:30:01), on plain timers like scheduleNightly:
 * the next run is scheduled only after the last one ended, from the clock
 * as it is then, so a slow run never overlaps the next and never drifts it;
 * a minute a slow run overran is skipped, not queued. Started by server.ts
 * only (the push reminders); the integration harness and the CLIs never
 * schedule anything.
 *
 * Stopping cannot lose a run's end: stop() clears the pending timer and
 * waits for a run in flight, at most STOP_WAIT_MS (a send has a 10 s socket
 * timeout per device), so the pool it uses is not ended under it. It never
 * rejects.
 */

export interface MinutelyJob {
  stop(): Promise<void>;
}

const MINUTE_MS = 60_000;
/** Past the minute's start, so the minute's wall-clock time has come. */
const OFFSET_MS = 1_000;
const STOP_WAIT_MS = 15_000;

export interface MinutelyOptions {
  name: string;
  /** Given the instant it runs for. */
  run: (now: Date) => Promise<unknown>;
  logger: Logger;
  now?: () => Date;
}

/** Milliseconds from `now` until a second past the next minute's start. */
export function untilNextMinute(now: Date): number {
  const time = now.getTime();
  const next = time - (time % MINUTE_MS) + MINUTE_MS + OFFSET_MS;
  // Within the first second of a minute the offset point is still ahead.
  return next - time > MINUTE_MS ? next - MINUTE_MS - time : next - time;
}

export function scheduleMinutely({
  name,
  run,
  logger,
  now = () => new Date(),
}: MinutelyOptions): MinutelyJob {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;

  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(tick, untilNextMinute(now()));
    // Never what keeps the process alive: the server's socket does that.
    timer.unref();
  };

  const tick = () => {
    running = (async () => {
      try {
        await run(now());
      } catch (error) {
        // Logged, never thrown: a failed minute must not stop the next.
        logger.error({ err: error }, `${name} failed`);
      }
    })();
    void running.then(() => {
      running = undefined;
      scheduleNext();
    });
  };

  logger.info(`${name} runs every minute`);
  scheduleNext();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      const inFlight = running;
      if (inFlight && !(await settlesWithin(inFlight, STOP_WAIT_MS))) {
        logger.warn(`${name} still running after ${STOP_WAIT_MS} ms; stopped`);
      }
    },
  };
}
