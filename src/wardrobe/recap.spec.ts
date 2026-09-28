import { describe, expect, it } from 'vitest';
import type { InsightGarment } from './insights';
import { RECAP_MIN_WEARS, type RecapPeriod, yearRecap } from './recap';

/**
 * The year in review (#26) from insights' rows read over a year: what is
 * counted as the year's (recentWearDays), what is an addition, the
 * threshold, whether an earlier year exists, and insights' own cost per
 * wear and colour rules reused. The window itself (the rows' days) is the
 * integration spec's (test/integration/recap.spec.ts).
 */

let nextId = 1;

function garment(fields: Partial<InsightGarment> = {}): InsightGarment {
  const id = nextId++;
  return {
    id,
    name: `Garment ${id}`,
    category: 'tops',
    brand: null,
    colors: null,
    quantity: 1,
    price: null,
    repairCost: null,
    condition: 'good',
    photo: null,
    acquiredOn: null,
    wearDays: 0,
    recentWearDays: 0,
    lastWorn: null,
    daysSinceWorn: null,
    daysOwned: null,
    ...fields,
  };
}

/** Worn `days` days in the year (and `before` days before it), last `since` days ago. */
function worn(
  days: number,
  fields: Partial<InsightGarment> & { before?: number; since?: number } = {},
): InsightGarment {
  const { before = 0, since = 1, ...rest } = fields;
  return garment({
    wearDays: days + before,
    recentWearDays: days,
    lastWorn: '2025-06-01',
    daysSinceWorn: since,
    ...rest,
  });
}

const YEAR_2025: RecapPeriod = {
  year: 2025,
  from: '2025-01-01',
  to: '2025-12-31',
  complete: true,
};

describe('yearRecap', () => {
  it('counts the year’s wears and pieces, and ranks the most worn by them', () => {
    const lifelong = worn(2, { before: 40 });
    const favourite = worn(9);
    const recent = worn(4, { since: 2 });
    const older = worn(4, { since: 30 });
    const unworn = garment({ wearDays: 12 });
    const recap = yearRecap(
      [lifelong, favourite, recent, older, unworn],
      [],
      YEAR_2025,
    );
    expect(recap.wears).toBe(2 + 9 + 4 + 4);
    expect(recap.piecesWorn).toBe(4);
    // The year's days, not the lifetime's; a tie the most recent first.
    expect(recap.mostWorn.map((g) => g.id)).toEqual([
      favourite.id,
      recent.id,
      older.id,
      lifelong.id,
    ]);
  });

  it(`needs ${RECAP_MIN_WEARS} wears to be a recap`, () => {
    expect(yearRecap([worn(RECAP_MIN_WEARS - 1)], [], YEAR_2025).enough).toBe(
      false,
    );
    expect(yearRecap([worn(RECAP_MIN_WEARS)], [], YEAR_2025).enough).toBe(true);
    // Additions alone are no recap: it is about what was worn.
    const added = garment({ acquiredOn: '2025-03-01' });
    expect(yearRecap([added], [], YEAR_2025).enough).toBe(false);
  });

  it('knows whether anything was worn before the year', () => {
    expect(yearRecap([worn(12)], [], YEAR_2025).earlier).toBe(false);
    expect(
      yearRecap([worn(12), worn(0, { before: 1 })], [], YEAR_2025).earlier,
    ).toBe(true);
  });

  it('lists the year’s additions by acquired date, the newest first, not the undated', () => {
    const march = garment({ acquiredOn: '2025-03-01' });
    const newYear = garment({ acquiredOn: '2025-01-01' });
    const lastDay = garment({ acquiredOn: '2025-12-31' });
    const before = garment({ acquiredOn: '2024-12-31' });
    const after = garment({ acquiredOn: '2026-01-01' });
    const undated = garment();
    const recap = yearRecap(
      [march, newYear, lastDay, before, after, undated],
      [],
      YEAR_2025,
    );
    expect(recap.additions.count).toBe(3);
    expect(recap.additions.garments.map((g) => g.id)).toEqual([
      lastDay.id,
      march.id,
      newYear.id,
    ]);
  });

  it('stops the additions at today in the current year', () => {
    const period: RecapPeriod = {
      year: 2026,
      from: '2026-01-01',
      to: '2026-09-27',
      complete: false,
    };
    const today = garment({ acquiredOn: '2026-09-27' });
    const tomorrow = garment({ acquiredOn: '2026-09-28' });
    const recap = yearRecap([today, tomorrow], [], period);
    expect(recap.additions.garments.map((g) => g.id)).toEqual([today.id]);
  });

  it('takes best value from the pieces worn in the year, by insights’ rule', () => {
    const cheap = worn(10, { price: '10.00' }); // 1.00 a wear
    const dear = worn(2, { price: '100.00' }); // 50.00 a wear
    const idle = garment({ price: '1.00', wearDays: 100 }); // not worn this year
    const recap = yearRecap([cheap, dear, idle], [], YEAR_2025);
    // The cheaper half of the two worn: insights' best.
    expect(recap.bestValue.map((c) => [c.garment.id, c.perWear])).toEqual([
      [cheap.id, '1.00'],
    ]);
  });

  it('shares the year’s wears among colours, the largest first, the uncoloured apart', () => {
    const navy = worn(6, { colors: ['blue'] });
    const split = worn(2, { colors: ['black', 'white'] });
    const plain = worn(2);
    const unwornRed = garment({ colors: ['red'] });
    const recap = yearRecap([navy, split, plain, unwornRed], [], YEAR_2025);
    expect(recap.colours.map((c) => [c.colour, c.worn])).toEqual([
      ['blue', 60],
      ['black', 10],
      ['white', 10],
    ]);
    expect(recap.uncolouredWorn).toBe(20);
  });

  it('names the pair worn together most, skipping rows it has no garment for', () => {
    const a = worn(5);
    const b = worn(5);
    const recap = yearRecap(
      [a, b],
      [
        { a: 999, b: a.id, days: 9 },
        { a: a.id, b: b.id, days: 4 },
      ],
      YEAR_2025,
    );
    expect(recap.pair).toEqual({ a, b, days: 4 });
    expect(yearRecap([a, b], [], YEAR_2025).pair).toBeNull();
  });
});
