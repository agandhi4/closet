import { describe, expect, it } from 'vitest';
import {
  templateDays,
  templateSlots,
  type TemplateSlot,
  weeklyRhythm,
} from './week';

/** The week template (#16): its days, its slots, and the rhythm derived from it. */

// Theo's week (src/seed/personas/demo.md): all day at home, the office
// Tuesday to Thursday, runs on Monday and Thursday, the gym on Saturday.
const THEO: TemplateSlot[] = [
  { weekday: 0, occasion: 'all-day' },
  { weekday: 1, occasion: 'all-day' },
  { weekday: 1, occasion: 'workout' },
  { weekday: 2, occasion: 'work' },
  { weekday: 3, occasion: 'work' },
  { weekday: 4, occasion: 'workout' },
  { weekday: 4, occasion: 'work' },
  { weekday: 5, occasion: 'all-day' },
  { weekday: 6, occasion: 'all-day' },
  { weekday: 6, occasion: 'workout' },
];

describe('the week template', () => {
  it('reads as seven days, Sunday first: the day occasion and what comes around it', () => {
    const days = templateDays(THEO);
    expect(days).toHaveLength(7);
    expect(days[1]).toEqual({
      weekday: 1,
      day: 'all-day',
      around: ['workout'],
    });
    expect(days[3]).toEqual({ weekday: 3, day: 'work', around: [] });
    expect(templateDays([])[0]).toEqual({ weekday: 0, day: null, around: [] });
  });

  it('turns back into the same slots, in weekday and occasion order', () => {
    expect(templateSlots(templateDays(THEO))).toEqual(THEO);
    expect(
      templateSlots([
        { weekday: 5, day: null, around: ['night-out', 'evening', 'evening'] },
      ]),
    ).toEqual([
      { weekday: 5, occasion: 'evening' },
      { weekday: 5, occasion: 'night-out' },
    ]);
  });

  it('derives the rhythm: on how many weekdays each occasion comes round', () => {
    expect(weeklyRhythm(THEO)).toEqual([
      { occasion: 'all-day', perWeek: 4 },
      { occasion: 'workout', perWeek: 3 },
      { occasion: 'work', perWeek: 3 },
    ]);
    expect(weeklyRhythm([])).toEqual([]);
  });
});
