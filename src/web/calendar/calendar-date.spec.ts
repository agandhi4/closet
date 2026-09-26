import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  dayOfWeek,
  daysInMonth,
  formatYearMonth,
  isValidTimeZone,
  parseIsoDate,
  parseYearMonth,
  startOfWeek,
  todayIn,
} from './calendar-date';

/**
 * The plain-date arithmetic the calendar runs on. Runs in America/New_York
 * (the `unit-new-york` project in vitest.config.ts): nothing here may depend
 * on the process's zone, and a DST zone is where a hidden local-time
 * dependency shows.
 */

describe('calendar dates', () => {
  it('runs in New York time (the project env took effect)', () => {
    expect(new Date('2026-01-15T12:00:00Z').getTimezoneOffset()).toBe(300);
    expect(new Date('2026-07-15T12:00:00Z').getTimezoneOffset()).toBe(240);
  });

  describe('parseIsoDate', () => {
    it.each(['2026-09-25', '2028-02-29', '2000-02-29', '1999-12-31'])(
      'accepts %s',
      (value) => {
        expect(parseIsoDate(value)).toBe(value);
      },
    );

    it.each([
      'garbage',
      '',
      '2026-9-25',
      '2026-09-25T00:00:00Z',
      ' 2026-09-25',
      '2026-13-01',
      '2026-00-10',
      '2026-09-00',
      '2026-09-31',
      '2027-02-29',
      '1900-02-29',
    ])('rejects %j', (value) => {
      expect(parseIsoDate(value)).toBeUndefined();
    });

    it('treats a missing value as absent', () => {
      expect(parseIsoDate(undefined)).toBeUndefined();
    });
  });

  describe('parseYearMonth', () => {
    it('reads YYYY-MM', () => {
      expect(parseYearMonth('2031-01')).toEqual({ year: 2031, month: 1 });
      expect(formatYearMonth({ year: 2031, month: 1 })).toBe('2031-01');
    });

    it.each(['garbage', '2031-13', '2031-00', '2031-1', '2031-01-01'])(
      'rejects %j',
      (value) => {
        expect(parseYearMonth(value)).toBeUndefined();
      },
    );
  });

  describe('todayIn (APP_TIMEZONE)', () => {
    it("at 21:30 on a Friday in New York it is New York's Friday, though UTC is on Saturday", () => {
      const now = new Date('2026-09-25T21:30:00-04:00');
      expect(now.toISOString().slice(0, 10)).toBe('2026-09-26');
      expect(todayIn('America/New_York', now)).toBe('2026-09-25');
    });

    it('follows the zone, not the process', () => {
      const now = new Date('2026-09-25T12:30:00Z');
      expect(todayIn('UTC', now)).toBe('2026-09-25');
      expect(todayIn('Pacific/Auckland', now)).toBe('2026-09-26');
      expect(todayIn('Pacific/Honolulu', now)).toBe('2026-09-25');
    });

    it('turns over at local midnight, including on DST days', () => {
      // Spring forward in New York: 2026-03-08, EST (-05:00) before.
      expect(
        todayIn('America/New_York', new Date('2026-03-08T04:59:59Z')),
      ).toBe('2026-03-07');
      expect(
        todayIn('America/New_York', new Date('2026-03-08T05:00:00Z')),
      ).toBe('2026-03-08');
      // Fall back: 2026-11-01, EDT (-04:00) before.
      expect(
        todayIn('America/New_York', new Date('2026-11-01T03:59:59Z')),
      ).toBe('2026-10-31');
      expect(
        todayIn('America/New_York', new Date('2026-11-01T04:00:00Z')),
      ).toBe('2026-11-01');
    });

    it('knows real zone names only', () => {
      expect(isValidTimeZone('America/New_York')).toBe(true);
      expect(isValidTimeZone('UTC')).toBe(true);
      expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
      expect(isValidTimeZone('')).toBe(false);
    });
  });

  describe('arithmetic', () => {
    it('steps days across months, years, leap days and DST changes', () => {
      expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
      expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
      expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
      expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
      expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
      expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
      expect(addDays('2026-11-01', 1)).toBe('2026-11-02');
      expect(addDays('2026-03-01', 7 * 52)).toBe('2027-02-28');
    });

    it('agrees with UTC calendar arithmetic on every day from 1970 to 2100', () => {
      const start = Date.UTC(1970, 0, 1);
      const end = Date.UTC(2100, 11, 31);
      let day = '1970-01-01';
      for (let t = start; t <= end; t += 86_400_000) {
        const utc = new Date(t);
        expect(day).toBe(utc.toISOString().slice(0, 10));
        expect(dayOfWeek(day)).toBe(utc.getUTCDay());
        day = addDays(day, 1);
      }
    });

    it('weeks start on Sunday', () => {
      expect(dayOfWeek('2026-09-20')).toBe(0);
      expect(dayOfWeek('2026-09-26')).toBe(6);
      expect(startOfWeek('2026-09-20')).toBe('2026-09-20');
      expect(startOfWeek('2026-09-26')).toBe('2026-09-20');
      expect(startOfWeek('2027-01-02')).toBe('2026-12-27');
      expect(startOfWeek('2026-03-14')).toBe('2026-03-08');
    });

    it('steps months across year boundaries', () => {
      expect(addMonths({ year: 2026, month: 12 }, 1)).toEqual({
        year: 2027,
        month: 1,
      });
      expect(addMonths({ year: 2027, month: 1 }, -1)).toEqual({
        year: 2026,
        month: 12,
      });
      expect(addMonths({ year: 2026, month: 5 }, -17)).toEqual({
        year: 2024,
        month: 12,
      });
    });

    it('knows the length of every month', () => {
      expect(daysInMonth({ year: 2028, month: 2 })).toBe(29);
      expect(daysInMonth({ year: 2027, month: 2 })).toBe(28);
      expect(daysInMonth({ year: 2000, month: 2 })).toBe(29);
      expect(daysInMonth({ year: 2100, month: 2 })).toBe(28);
      expect(daysInMonth({ year: 2026, month: 9 })).toBe(30);
      expect(daysInMonth({ year: 2026, month: 10 })).toBe(31);
    });
  });
});
