import { describe, expect, it } from 'vitest';
import { conditionOf } from '../weather/forecast';
import { weatherNeeds } from '../weather/match';
import {
  BANDS,
  type Band,
  bandOf,
  forecastDayOf,
  normalHigh,
  weatherFor,
} from './weather';

/**
 * The torso warmth (src/weather/match.ts) the matching asks of each band's
 * days, for the whole waking day: the bible's bands and the app's rule
 * agree when every day of a band lands in its range.
 */
const BAND_TORSO: Readonly<Record<Band, { min: number; max: number }>> = {
  hot: { min: 1, max: 2 },
  warm: { min: 1, max: 4 },
  mild: { min: 3, max: 5 },
  cool: { min: 4, max: 7 },
  cold: { min: 6, max: 9 },
  freezing: { min: 8, max: 9 },
};

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

  describe('as a forecast (what the Open-Meteo stand-in serves)', () => {
    const year = weatherFor('demo', '2026-01-01', 365);

    it('asks the matching for more warmth in every colder band', () => {
      const medians = BANDS.map((band) => {
        const targets = year
          .filter((w) => w.band === band)
          .map((w) => weatherNeeds(forecastDayOf('demo', w), 'all-day', 0)!)
          .map((needs) => needs.torso)
          .sort((a, b) => a - b);
        for (const target of targets) {
          expect(target).toBeGreaterThanOrEqual(BAND_TORSO[band].min);
          expect(target).toBeLessThanOrEqual(BAND_TORSO[band].max);
        }
        return targets[Math.floor(targets.length / 2)];
      });
      // Hottest first: each band's median asks at least as much as the last.
      expect(medians).toEqual([...medians].sort((a, b) => a - b));
      expect(medians[0]).toBe(1);
      expect(medians[BANDS.length - 1]).toBe(9);
    });

    it("keeps the day's high, and rains on its rainy days", () => {
      for (const weather of year.slice(150, 240)) {
        const day = forecastDayOf('demo', weather);
        expect(day.day).toBe(weather.day);
        expect(day.hours.map((h) => h.hour)).toEqual(
          Array.from({ length: 24 }, (_, h) => h),
        );
        const feelsHigh = Math.max(...day.hours.map((h) => h.feelsLike));
        expect(feelsHigh).toBeCloseTo(((weather.high - 32) * 5) / 9, 0);
        expect(day.high).toBeLessThanOrEqual(feelsHigh + 0.1);
        const rainy = day.hours.some((h) => h.precipitationChance >= 50);
        expect(rainy).toBe(weather.rain);
        expect(conditionOf(day.code) === 'rain').toBe(weather.rain);
      }
    });

    it('is the same day whenever it is asked for', () => {
      const [day] = weatherFor('demo', '2026-07-04', 1);
      expect(forecastDayOf('demo', day)).toEqual(forecastDayOf('demo', day));
      expect(forecastDayOf('demo', day)).toEqual(
        forecastDayOf('demo', year.find((w) => w.day === '2026-07-04')!),
      );
    });
  });
});
