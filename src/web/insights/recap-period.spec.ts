import { describe, expect, it } from 'vitest';
import { recapPeriod, recapYear } from './recap-period';

describe('recap period (#26)', () => {
  const today = '2026-09-27';

  it('reads ?year= as navigation state: a four-digit year up to this one, else this one', () => {
    expect(recapYear(undefined, today)).toBe(2026);
    expect(recapYear('2025', today)).toBe(2025);
    expect(recapYear('1999', today)).toBe(1999);
    expect(recapYear('2027', today)).toBe(2026);
    expect(recapYear('25', today)).toBe(2026);
    expect(recapYear('2025abc', today)).toBe(2026);
    expect(recapYear('x'.repeat(5000), today)).toBe(2026);
  });

  it('runs a past year to December 31 and the current one to today', () => {
    expect(recapPeriod(2025, today)).toEqual({
      year: 2025,
      from: '2025-01-01',
      to: '2025-12-31',
      complete: true,
    });
    expect(recapPeriod(2026, today)).toEqual({
      year: 2026,
      from: '2026-01-01',
      to: today,
      complete: false,
    });
  });

  it('keeps New Year’s Eve in the old year: today is the household’s date', () => {
    expect(recapPeriod(2026, '2026-12-31')).toMatchObject({
      to: '2026-12-31',
      complete: false,
    });
    expect(recapPeriod(2026, '2027-01-01').complete).toBe(true);
  });
});
