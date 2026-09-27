import { addDays, instantAt, todayIn } from '../web/calendar/calendar-date';
import type { Logger } from '../logger';

/**
 * A once-a-day job at a wall-clock hour in the household's zone
 * (APP_TIMEZONE), on plain timers: the next run is computed afresh after
 * every run, so DST changes and a slow run never drift it, and runs never
 * overlap. Started by server.ts (the server) only; the integration harness
 * and the CLIs never schedule anything.
 */

export interface NightlyJob {
  stop(): void;
}

export interface NightlyOptions {
  name: string;
  /** Hour of the day, 0-23, in `timeZone`. */
  hour: number;
  timeZone: string;
  run: () => Promise<unknown>;
  logger: Logger;
  now?: () => Date;
}

export function scheduleNightly({
  name,
  hour,
  timeZone,
  run,
  logger,
  now = () => new Date(),
}: NightlyOptions): NightlyJob {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const scheduleNext = () => {
    if (stopped) return;
    const at = nextRunAt(now(), timeZone, hour);
    logger.info(`${name} next runs at ${at.toISOString()}`);
    timer = setTimeout(() => {
      void (async () => {
        try {
          await run();
        } catch (error) {
          // Logged, never thrown: a failed night must not stop the next one.
          logger.error({ err: error }, `${name} failed`);
        }
        scheduleNext();
      })();
    }, at.getTime() - now().getTime());
    // Never what keeps the process alive: the server's socket does that.
    timer.unref();
  };

  scheduleNext();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

/** The first instant after `now` at `hour`:00 on a wall clock in `timeZone`. */
export function nextRunAt(now: Date, timeZone: string, hour: number): Date {
  const today = todayIn(timeZone, now);
  // An hour a DST change skips comes out an hour off (instantAt); 03:00
  // exists on every day in the US and EU zones (their changes skip
  // 02:00-03:00).
  const candidate = instantAt(today, hour, timeZone);
  return candidate > now
    ? candidate
    : instantAt(addDays(today, 1), hour, timeZone);
}
