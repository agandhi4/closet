import { addDays, todayIn } from '../web/calendar/calendar-date';
import type { WebLogger } from '../web/logger';

/**
 * A once-a-day job at a wall-clock hour in the household's zone
 * (APP_TIMEZONE), on plain timers: the next run is computed afresh after
 * every run, so DST changes and a slow run never drift it, and runs never
 * overlap. Started by main.ts (the server) only; the integration harness
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
  logger: WebLogger;
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
    logger.log(`${name} next runs at ${at.toISOString()}`);
    timer = setTimeout(() => {
      void (async () => {
        try {
          await run();
        } catch (error) {
          // Logged, never thrown: a failed night must not stop the next one.
          logger.error(
            `${name} failed`,
            error instanceof Error ? error.stack : String(error),
          );
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
  const candidate = zonedTime(today, hour, timeZone);
  return candidate > now
    ? candidate
    : zonedTime(addDays(today, 1), hour, timeZone);
}

// `date` at `hour`:00 in `timeZone`. The offset is read at the UTC guess and
// again at the result, which settles it on either side of a DST change. An
// hour a change skips has no answer and comes out an hour off; 03:00 exists
// on every day in the US and EU zones (their changes skip 02:00-03:00).
function zonedTime(date: string, hour: number, timeZone: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  const guess = Date.UTC(year, month - 1, day, hour);
  const first = guess - offsetMs(timeZone, guess);
  const offset = offsetMs(timeZone, first);
  return new Date(guess - offset);
}

// How far `timeZone`'s wall clock is ahead of UTC at `instant`.
function offsetMs(timeZone: string, instant: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
      .formatToParts(instant)
      .map(({ type, value }) => [type, Number(value)]),
  ) as Record<Intl.DateTimeFormatPartTypes, number>;
  const wall = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return wall - (instant - (instant % 1000));
}
