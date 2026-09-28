import type { Logger } from '../logger';
import { awaitRunInFlight, type ScheduledJob } from './scheduled';

/**
 * A job at the start of every minute (a second past it, so a 07:30 reminder
 * is due when it runs at 07:30:01), or of every `everyMinutes` minutes (the
 * order mail's poll), on plain timers like scheduleNightly:
 * the next run is scheduled only after the last one ended, from the clock
 * as it is then, so a slow run never overlaps the next and never drifts it;
 * a minute a slow run overran is skipped, not queued. Started by server.ts
 * only (the push reminders); the integration harness and the CLIs never
 * schedule anything.
 *
 * Stopping cannot lose a run's end: stop() clears the pending timer and
 * waits for a run in flight, bounded (ScheduledJob, STOP_WAIT_MS), so the
 * pool it uses is not ended under it.
 */

const MINUTE_MS = 60_000;
/** Past the minute's start, so the minute's wall-clock time has come. */
const OFFSET_MS = 1_000;

export interface MinutelyOptions {
  name: string;
  /** Given the instant it runs for. */
  run: (now: Date) => Promise<unknown>;
  /** Minutes between runs, on multiples of it since the epoch; 1 by default. */
  everyMinutes?: number;
  logger: Logger;
  now?: () => Date;
}

/**
 * Milliseconds from `now` until a second past the next start of a period
 * of `everyMinutes` minutes (every minute by default).
 */
export function untilNextMinute(now: Date, everyMinutes = 1): number {
  const period = MINUTE_MS * everyMinutes;
  const time = now.getTime();
  const next = time - (time % period) + period + OFFSET_MS;
  // Within the first second of a period the offset point is still ahead.
  return next - time > period ? next - period - time : next - time;
}

export function scheduleMinutely({
  name,
  run,
  everyMinutes = 1,
  logger,
  now = () => new Date(),
}: MinutelyOptions): ScheduledJob {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;

  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(tick, untilNextMinute(now(), everyMinutes));
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

  logger.info(
    `${name} runs every ${everyMinutes === 1 ? 'minute' : `${everyMinutes} minutes`}`,
  );
  scheduleNext();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await awaitRunInFlight(name, running, logger);
    },
  };
}
