import { describe, expect, it } from 'vitest';
import { addDays, dayOfWeek } from '../web/calendar/calendar-date';
import { type BibleOccasion, loadPersona } from './persona';
import { HISTORY_DAYS, simulate } from './simulate';

/** Theo's simulated history: deterministic, and it reads like a life. */
describe('simulate', () => {
  const demo = loadPersona('demo');
  const life = simulate(demo, '2026-09-26');
  const outfit = (i: number) => demo.outfits[i];
  const garments = new Map(demo.garments.map((g) => [g.id, g]));

  it('is the same on every run', () => {
    expect(simulate(demo, '2026-09-26')).toEqual(life);
  });

  it('covers the 13 weeks up to the anchor, then plans the week after, unworn', () => {
    expect(life.first).toBe(addDays('2026-09-26', -(HISTORY_DAYS - 1)));
    const past = life.entries.filter((e) => e.day <= '2026-09-26');
    const planned = life.entries.filter((e) => e.day > '2026-09-26');
    expect(past.length).toBeGreaterThan(75);
    expect(past.filter((e) => e.worn).length).toBeGreaterThan(70);
    expect(new Set(planned.map((e) => e.day)).size).toBe(7);
    expect(planned.every((e) => !e.worn)).toBe(true);
  });

  it('keeps the events: the wedding, the beach, the conference day he forgot', () => {
    const on = (day: string) =>
      life.entries
        .filter((e) => e.day === day)
        .map((e) => outfit(e.outfit).name);
    expect(on('2026-08-29')).toEqual(['Wedding']);
    expect(on('2026-07-18')).toEqual(['Rockaway']);
    expect(on('2026-08-20')).toEqual([]);
  });

  it('wears nothing before he bought it or after he archived it', () => {
    for (const entry of life.entries) {
      for (const id of outfit(entry.outfit).garmentIds) {
        const g = garments.get(id)!;
        if (g.fields.acquiredOn)
          expect(entry.day >= g.fields.acquiredOn).toBe(true);
        if (g.archivedOn) expect(entry.day < g.archivedOn).toBe(true);
      }
    }
  });

  it('dresses for the day: office outfits on office days, weekend ones at weekends', () => {
    const office = life.entries.filter(
      (e) =>
        e.worn &&
        [2, 4].includes(dayOfWeek(e.day)) &&
        outfit(e.outfit).occasions.includes('office'),
    );
    expect(office.length).toBeGreaterThan(10);
    const workwear = life.entries.filter((e) =>
      outfit(e.outfit).occasions.includes('office'),
    );
    expect(workwear.every((e) => [2, 3, 4].includes(dayOfWeek(e.day)))).toBe(
      true,
    );
    const dates = life.entries.filter((e) =>
      outfit(e.outfit).occasions.includes('date'),
    );
    expect(dates.length).toBeGreaterThanOrEqual(6);
  });

  it('repeats favourites, as real closets do', () => {
    // The drawn outfits: the workouts are the week's, not a draw.
    const drawn = life.entries.filter((e) => e.occasion !== 'workout');
    const counts = new Map<number, number>();
    for (const e of drawn)
      counts.set(e.outfit, (counts.get(e.outfit) ?? 0) + 1);
    const top3 = [...counts.values()]
      .sort((a, b) => b - a)
      .slice(0, 3)
      .reduce((a, b) => a + b, 0);
    expect(top3 / drawn.length).toBeGreaterThan(0.25);
    expect(top3 / drawn.length).toBeLessThan(0.45);
  });

  it('plans each entry for its part of the day (#13)', () => {
    const occasionsOf = (use: BibleOccasion) =>
      new Set(
        life.entries
          .filter((e) => outfit(e.outfit).occasions.includes(use))
          .map((e) => e.occasion),
      );
    expect(occasionsOf('office')).toEqual(new Set(['work']));
    expect(occasionsOf('meeting')).toEqual(new Set(['work']));
    expect(occasionsOf('date')).toEqual(new Set(['evening']));
    expect(occasionsOf('night-out')).toEqual(new Set(['night-out']));
    expect(occasionsOf('wfh')).toEqual(new Set(['all-day']));
    expect(occasionsOf('formal')).toEqual(new Set(['all-day']));
  });

  it('runs on Monday and Thursday mornings and goes to the gym on Saturday, most weeks', () => {
    const workouts = life.entries.filter((e) => e.occasion === 'workout');
    expect(workouts.length).toBeGreaterThan(20);
    for (const e of workouts) {
      expect([1, 4, 6]).toContain(dayOfWeek(e.day));
      expect(outfit(e.outfit).name).toBe(
        dayOfWeek(e.day) === 6 ? 'Gym' : 'Run',
      );
    }
    // Never on an event day (the wedding and the beach were Saturdays).
    const days = workouts.map((e) => e.day);
    expect(days).not.toContain('2026-08-29');
    expect(days).not.toContain('2026-07-18');
    // Skipped some mornings: fewer than every one in the 13 weeks.
    expect(days.filter((day) => day <= '2026-09-26').length).toBeLessThan(
      13 * 3,
    );
  });

  it('has days of three outfits: a workout, the day, the evening', () => {
    const byDay = new Map<string, Set<string>>();
    for (const e of life.entries) {
      byDay.set(e.day, (byDay.get(e.day) ?? new Set()).add(e.occasion));
    }
    expect(
      [...byDay.values()].filter((occasions) => occasions.size === 3).length,
    ).toBeGreaterThan(0);
  });

  it('leaves the anchor half lived for Today (#15): the morning worn, the evening planned, the day’s outfit not chosen', () => {
    const on = (entries: typeof life.entries, day: string) =>
      entries
        .filter((e) => e.day === day)
        .map((e) => [e.occasion, outfit(e.outfit).name, e.worn]);
    expect(on(life.entries, '2026-09-26')).toEqual([
      ['evening', 'Summer date', false],
    ]);
    // Anchored on the next Saturday: the gym is done, the date is tonight.
    expect(on(simulate(demo, '2026-10-03').entries, '2026-10-03')).toEqual([
      ['workout', 'Gym', true],
      ['evening', 'Date night: leather', false],
    ]);
  });

  it('shifts to another anchor by whole weeks and dresses for that season', () => {
    const winter = simulate(demo, '2027-01-16');
    expect(winter.shiftDays % 7).toBe(0);
    const names = new Set(winter.entries.map((e) => outfit(e.outfit).name));
    expect(names.has('Summer shorts')).toBe(false);
    expect(names.has('Rockaway')).toBe(false);
    expect(names.has('Merino office')).toBe(true);
  });

  it('does laundry on the Sundays up to the anchor, washing what can be washed', () => {
    expect(life.washes.length).toBeGreaterThanOrEqual(12);
    expect(life.washes.every((w) => dayOfWeek(w.day) === 0)).toBe(true);
    expect(life.washes.every((w) => w.day <= '2026-09-26')).toBe(true);
    expect(life.washes.at(-1)?.day).toBe('2026-09-20');
    const washed = new Set(life.washes.flatMap((w) => w.garmentIds));
    // Tops go in every week; the raw denim never; shoes are not laundered.
    expect(washed.has('T01')).toBe(true);
    expect(washed.has('B01')).toBe(false);
    expect([...washed].some((id) => id.startsWith('F'))).toBe(false);
  });

  it('writes no history for personas without a week', () => {
    expect(simulate(loadPersona('sparse'), '2026-09-26').entries).toEqual([]);
  });
});
