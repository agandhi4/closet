import { describe, expect, it } from 'vitest';
import { dayRefusal, REPLAY_WINDOW_DAYS } from './offline-writes';

describe('dayRefusal', () => {
  const today = '2026-03-02';

  it('accepts today and back to the window’s first day, across a month end', () => {
    expect(REPLAY_WINDOW_DAYS).toBe(7);
    for (const day of ['2026-03-02', '2026-03-01', '2026-02-23']) {
      expect(dayRefusal(day, today), day).toBeUndefined();
    }
  });

  it('refuses a day before the window as too old and one after today as future', () => {
    expect(dayRefusal('2026-02-22', today)).toBe('too-old');
    expect(dayRefusal('2026-03-03', today)).toBe('future');
  });
});
