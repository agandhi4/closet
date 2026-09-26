import { describe, expect, it } from 'vitest';
import { bandOf, normalHigh, weatherFor } from './weather';

describe('weather', () => {
  it('interpolates the normal highs between month mid-points', () => {
    expect(normalHigh('2026-07-15')).toBe(84);
    expect(normalHigh('2026-01-15')).toBe(39);
    expect(normalHigh('2026-12-31')).toBeGreaterThan(39);
    expect(normalHigh('2026-12-31')).toBeLessThan(44);
  });

  it('bands feels-like highs as the bible says', () => {
    expect([90, 85, 84, 75, 70, 60, 45, 20].map(bandOf)).toEqual([
      'hot',
      'hot',
      'warm',
      'warm',
      'mild',
      'cool',
      'cold',
      'freezing',
    ]);
  });

  it('depends on the date alone, whatever window it is read in', () => {
    const long = weatherFor('demo', '2026-06-01', 60);
    const short = weatherFor('demo', '2026-07-01', 5);
    expect(short).toEqual(long.slice(30, 35));
  });

  it('is summer in July and winter in January, and a shift moves a day', () => {
    const july = weatherFor('demo', '2026-07-01', 31);
    const january = weatherFor('demo', '2027-01-01', 31);
    const mean = (days: { high: number }[]) =>
      days.reduce((s, d) => s + d.high, 0) / days.length;
    expect(mean(july)).toBeGreaterThan(80);
    expect(mean(january)).toBeLessThan(45);
    const [hot] = weatherFor('demo', '2026-07-21', 1, () => 8);
    const [plain] = weatherFor('demo', '2026-07-21', 1);
    expect(hot.high).toBeGreaterThan(plain.high);
  });
});
