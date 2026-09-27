import { describe, expect, it } from 'vitest';
import {
  compareOccasions,
  DEFAULT_OCCASION,
  isOccasion,
  OCCASION_HINTS,
  OCCASIONS,
} from './occasions';
import { FORMALITIES } from './properties';

describe('occasions', () => {
  it('are the six of the plan, all day first and the default', () => {
    expect(OCCASIONS).toEqual([
      'all-day',
      'workout',
      'work',
      'daytime',
      'evening',
      'night-out',
    ]);
    expect(DEFAULT_OCCASION).toBe('all-day');
  });

  it('after all day, follow the order their windows start', () => {
    const starts = OCCASIONS.slice(1).map((o) => OCCASION_HINTS[o].window.from);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('each have a window within the day and a formality range on the scale', () => {
    for (const occasion of OCCASIONS) {
      const { window, formality } = OCCASION_HINTS[occasion];
      expect(window.from, occasion).toBeGreaterThanOrEqual(0);
      expect(window.to, occasion).toBeLessThanOrEqual(24);
      expect(window.from, occasion).toBeLessThan(window.to);
      expect(FORMALITIES, occasion).toContain(formality.min);
      expect(FORMALITIES, occasion).toContain(formality.max);
      expect(formality.min, occasion).toBeLessThanOrEqual(formality.max);
    }
  });

  it('carry the plan section 8 defaults: work is at least smart casual, a workout is lounge', () => {
    expect(OCCASION_HINTS.work).toEqual({
      window: { from: 8, to: 18 },
      formality: { min: 3, max: 4 },
    });
    expect(OCCASION_HINTS.evening.window).toEqual({ from: 18, to: 23 });
    expect(OCCASION_HINTS.workout.formality).toEqual({ min: 1, max: 1 });
  });

  it('sort a day into display order, keeping the order of ties', () => {
    const day = [
      { id: 1, occasion: 'evening' as const },
      { id: 2, occasion: 'work' as const },
      { id: 3, occasion: 'all-day' as const },
      { id: 4, occasion: 'evening' as const },
      { id: 5, occasion: 'workout' as const },
    ];
    expect(
      day
        .sort((a, b) => compareOccasions(a.occasion, b.occasion))
        .map((e) => e.id),
    ).toEqual([3, 5, 2, 1, 4]);
  });

  it('recognise only their own values', () => {
    expect(isOccasion('night-out')).toBe(true);
    expect(isOccasion('night out')).toBe(false);
    expect(isOccasion('office')).toBe(false);
    expect(isOccasion('')).toBe(false);
  });
});
