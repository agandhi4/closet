import { describe, expect, it } from 'vitest';
import { dateLabel, relativeDay } from './date-labels';

describe('relativeDay', () => {
  const today = '2026-10-09';

  it.each([
    ['2026-10-09', 'today'],
    ['2026-10-08', 'yesterday'],
    ['2026-10-07', '2 days ago'],
    ['2026-10-03', '6 days ago'],
    ['2026-10-02', 'Fri, Oct 2'],
    ['2026-01-01', 'Thu, Jan 1'],
    ['2025-12-31', 'Dec 31, 2025'],
    // A day ahead is a date, never "-1 days ago".
    ['2026-10-10', 'Sat, Oct 10'],
  ])('%s is "%s"', (day, label) => {
    expect(relativeDay(day, today)).toBe(label);
  });
});

describe('dateLabel', () => {
  it('names the weekday in the year of today, the year otherwise', () => {
    expect(dateLabel('2026-09-29', '2026-10-09')).toBe('Tue, Sep 29');
    expect(dateLabel('2025-09-29', '2026-10-09')).toBe('Sep 29, 2025');
    expect(dateLabel('2027-01-04', '2026-12-31')).toBe('Jan 4, 2027');
  });
});
