import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REMINDER_TIMES,
  dueReminders,
  formatMinuteOfDay,
  isReminderChoice,
  LATE_LIMIT_MINUTES,
  REMINDER_KINDS,
  REMINDER_WINDOWS,
  type ReminderDevice,
  reminderChoices,
} from './reminders';

// Every instant is explicit UTC and every zone named, so these hold in any
// process zone.
const NY = 'America/New_York';
const at = (iso: string) => new Date(iso);

function device(overrides: Partial<ReminderDevice> = {}): ReminderDevice {
  return {
    id: 1,
    userId: 7,
    morning: 7 * 60 + 30,
    evening: 21 * 60,
    setAt: at('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

const kinds = (devices: ReminderDevice[], now: string, zone = NY) =>
  dueReminders(devices, at(now), zone).map((r) => [r.deviceId, r.kind, r.day]);

describe('the choices', () => {
  it('are quarter hours inside each window, the defaults among them', () => {
    expect(reminderChoices('morning')).toHaveLength(25);
    expect(reminderChoices('morning')[0]).toBe(5 * 60);
    expect(reminderChoices('evening').at(-1)).toBe(23 * 60);
    for (const kind of REMINDER_KINDS) {
      expect(isReminderChoice(kind, DEFAULT_REMINDER_TIMES[kind])).toBe(true);
    }
    expect(isReminderChoice('morning', 7 * 60 + 10)).toBe(false);
    expect(isReminderChoice('morning', 12 * 60)).toBe(false);
    expect(isReminderChoice('evening', 7 * 60)).toBe(false);
    expect(isReminderChoice('evening', 21.5)).toBe(false);
    expect(formatMinuteOfDay(7 * 60 + 30)).toBe('07:30');
    expect(formatMinuteOfDay(23 * 60)).toBe('23:00');
  });

  it('never send on another day: the latest time plus the late limit is before midnight', () => {
    expect(REMINDER_WINDOWS.evening.to + LATE_LIMIT_MINUTES).toBeLessThan(
      24 * 60,
    );
    // And away from the hours US and EU DST changes skip or repeat.
    for (const kind of REMINDER_KINDS) {
      expect(REMINDER_WINDOWS[kind].from).toBeGreaterThanOrEqual(4 * 60);
    }
  });
});

describe('dueReminders', () => {
  it('is due at its wall-clock minute in the zone, winter and summer', () => {
    // 07:30 EST is 12:30 UTC; 07:30 EDT is 11:30 UTC.
    expect(kinds([device()], '2026-01-15T12:29:59Z')).toEqual([]);
    expect(kinds([device()], '2026-01-15T12:30:01Z')).toEqual([
      [1, 'morning', '2026-01-15'],
    ]);
    expect(kinds([device()], '2026-07-15T11:30:01Z')).toEqual([
      [1, 'morning', '2026-07-15'],
    ]);
    // 21:00 EDT is 01:00 UTC the next day: still the household's day.
    expect(kinds([device()], '2026-07-16T01:00:01Z')).toEqual([
      [1, 'evening', '2026-07-15'],
    ]);
  });

  it('keeps the wall-clock time on both DST days', () => {
    // Spring forward, 8 March 2026: 07:30 is EDT, 11:30 UTC.
    expect(kinds([device()], '2026-03-08T11:30:01Z')).toEqual([
      [1, 'morning', '2026-03-08'],
    ]);
    // An hour later in UTC is 08:30 local: past the late limit.
    expect(kinds([device()], '2026-03-08T12:30:01Z')).toEqual([]);
    // Fall back, 1 November 2026: 07:30 is EST, 12:30 UTC.
    expect(kinds([device()], '2026-11-01T11:30:01Z')).toEqual([]);
    expect(kinds([device()], '2026-11-01T12:30:01Z')).toEqual([
      [1, 'morning', '2026-11-01'],
    ]);
  });

  it(`stays due for ${LATE_LIMIT_MINUTES} minutes (a restart across its minute), then not`, () => {
    expect(kinds([device()], '2026-01-15T13:00:00Z')).toEqual([
      [1, 'morning', '2026-01-15'],
    ]);
    expect(kinds([device()], '2026-01-15T13:00:01Z')).toEqual([]);
  });

  it('waits for tomorrow when the settings were saved after the time today', () => {
    const late = device({ setAt: at('2026-01-15T13:15:00Z') });
    // 08:15 New York: the 07:30 reminder was set after its time.
    expect(kinds([late], '2026-01-15T13:15:30Z')).toEqual([]);
    // The evening one, still ahead, goes out tonight.
    expect(kinds([late], '2026-01-16T02:00:01Z')).toEqual([
      [late.id, 'evening', '2026-01-15'],
    ]);
    // The next morning.
    expect(kinds([late], '2026-01-16T12:30:01Z')).toEqual([
      [late.id, 'morning', '2026-01-16'],
    ]);
  });

  it('sends nothing for a reminder that is off, or a device never set', () => {
    expect(kinds([device({ morning: null })], '2026-01-15T12:30:01Z')).toEqual(
      [],
    );
    expect(
      kinds(
        [device({ morning: null, evening: null, setAt: null })],
        '2026-01-15T12:30:01Z',
      ),
    ).toEqual([]);
  });

  it('reads each device on its own, in the zone given', () => {
    // 07:15: a quarter of an hour late at 07:30, still due.
    const early = device({ id: 2, userId: 8, morning: 7 * 60 + 15 });
    expect(
      kinds([device(), early], '2026-01-15T12:30:01Z').map(([id]) => id),
    ).toEqual([1, 2]);
    // Auckland: 07:30 NZDT (UTC+13) on 16 January is 18:30 UTC on the 15th.
    expect(
      kinds([device()], '2026-01-15T18:30:01Z', 'Pacific/Auckland'),
    ).toEqual([[1, 'morning', '2026-01-16']]);
  });
});
