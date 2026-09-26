import { describe, expect, it } from 'vitest';
import { addDays, dayOfWeek } from '../web/calendar/calendar-date';
import { loadPersona } from './persona';
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
    const counts = new Map<number, number>();
    for (const e of life.entries)
      counts.set(e.outfit, (counts.get(e.outfit) ?? 0) + 1);
    const top3 = [...counts.values()]
      .sort((a, b) => b - a)
      .slice(0, 3)
      .reduce((a, b) => a + b, 0);
    expect(top3 / life.entries.length).toBeGreaterThan(0.25);
    expect(top3 / life.entries.length).toBeLessThan(0.45);
  });

  it('shifts to another anchor by whole weeks and dresses for that season', () => {
    const winter = simulate(demo, '2027-01-16');
    expect(winter.shiftDays % 7).toBe(0);
    const names = new Set(winter.entries.map((e) => outfit(e.outfit).name));
    expect(names.has('Summer shorts')).toBe(false);
    expect(names.has('Rockaway')).toBe(false);
    expect(names.has('Merino office')).toBe(true);
  });

  it('writes no history for personas without a week', () => {
    expect(simulate(loadPersona('sparse'), '2026-09-26').entries).toEqual([]);
  });
});
