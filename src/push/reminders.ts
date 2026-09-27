import {
  instantAt,
  type IsoDate,
  todayIn,
} from '../web/calendar/calendar-date';

/**
 * The push reminders' schedule (#15; plan section 9), pure: which reminders
 * there are, the times a device may choose, and which are due at an
 * instant. The database's check constraints are built from the constants
 * here (src/db/schema.ts, user_device and push_reminder), and the scheduler
 * (src/web/push/reminders.ts) asks dueReminders every minute.
 *
 * A reminder is due once per device and day, at its wall-clock time in
 * APP_TIMEZONE on that day (instantAt, so a DST day keeps 07:30 at 07:30),
 * and only:
 * - after the device's settings were last saved, so a device that turns a
 *   reminder on after its time today gets the first one tomorrow;
 * - within LATE_LIMIT_MINUTES of its time, so a server that was down (a
 *   deploy, a crash) catches up on a minute it missed but never sends a
 *   morning reminder at noon.
 * "Once" is the database's to guarantee (the claim, push_reminder's
 * primary key), not this function's: it may name a reminder already sent.
 */

export const REMINDER_KINDS = ['morning', 'evening'] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

/** Minutes after midnight, in APP_TIMEZONE. */
export type MinuteOfDay = number;

/** The steps a time is chosen in. */
export const REMINDER_STEP_MINUTES = 15;

/**
 * The times each reminder may be set to, both ends included. Away from
 * midnight and from 01:00-03:00, where DST changes happen in the US and EU
 * (a skipped or doubled wall time), and far enough before midnight that a
 * late send (LATE_LIMIT_MINUTES) is still the same day.
 */
export const REMINDER_WINDOWS: Readonly<
  Record<ReminderKind, { from: MinuteOfDay; to: MinuteOfDay }>
> = {
  morning: { from: 5 * 60, to: 11 * 60 },
  evening: { from: 17 * 60, to: 23 * 60 },
};

/** What a device turns on with before choosing: a time most people are up and home. */
export const DEFAULT_REMINDER_TIMES: Readonly<
  Record<ReminderKind, MinuteOfDay>
> = {
  morning: 7 * 60 + 30,
  evening: 21 * 60,
};

/** How late a reminder may still go out (a restart across its minute). */
export const LATE_LIMIT_MINUTES = 30;

/** Every time a reminder may be set to, in order. */
export function reminderChoices(kind: ReminderKind): MinuteOfDay[] {
  const { from, to } = REMINDER_WINDOWS[kind];
  const choices: MinuteOfDay[] = [];
  for (let minute = from; minute <= to; minute += REMINDER_STEP_MINUTES) {
    choices.push(minute);
  }
  return choices;
}

export function isReminderChoice(
  kind: ReminderKind,
  minute: number,
): minute is MinuteOfDay {
  const { from, to } = REMINDER_WINDOWS[kind];
  return (
    Number.isInteger(minute) &&
    minute >= from &&
    minute <= to &&
    (minute - from) % REMINDER_STEP_MINUTES === 0
  );
}

/** "07:30", the value a time select posts and shows. */
export function formatMinuteOfDay(minute: MinuteOfDay): string {
  const hours = Math.floor(minute / 60);
  return `${String(hours).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

/** A device's reminder settings, as the scheduler reads them. */
export interface ReminderDevice {
  id: number;
  userId: number;
  morning: MinuteOfDay | null;
  evening: MinuteOfDay | null;
  /** When the settings were last saved; null when no reminder was ever on. */
  setAt: Date | null;
}

export interface DueReminder {
  deviceId: number;
  userId: number;
  kind: ReminderKind;
  /** The household's day the reminder is for. */
  day: IsoDate;
  /** When it was due. */
  at: Date;
}

/** The reminders due at `now`: each device's, today in `timeZone`. */
export function dueReminders(
  devices: readonly ReminderDevice[],
  now: Date,
  timeZone: string,
): DueReminder[] {
  const day = todayIn(timeZone, now);
  const earliest = now.getTime() - LATE_LIMIT_MINUTES * 60_000;
  const due: DueReminder[] = [];
  for (const device of devices) {
    if (!device.setAt) continue;
    for (const kind of REMINDER_KINDS) {
      const minute = device[kind];
      if (minute === null) continue;
      const at = instantAt(day, Math.floor(minute / 60), timeZone, minute % 60);
      const time = at.getTime();
      if (
        time <= now.getTime() &&
        time >= earliest &&
        time > device.setAt.getTime()
      ) {
        due.push({ deviceId: device.id, userId: device.userId, kind, day, at });
      }
    }
  }
  return due;
}
