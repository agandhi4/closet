import { describe, expect, it } from 'vitest';
import {
  BRANDS_LIMIT,
  type InsightGarment,
  RANKED_LIMIT,
  wardrobeInsights,
} from './insights';

/**
 * The rules test/integration/insights.spec.ts cannot reach on a closet of
 * eight: empty closets, the brands past BRANDS_LIMIT, and how cost per wear
 * splits a small or a large closet into best and worst. The definitions
 * themselves are proven there, over real wears.
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
    condition: 'good',
    photo: null,
    wearDays: 0,
    recentWearDays: 0,
    lastWorn: null,
    daysSinceWorn: null,
    daysOwned: null,
    ...fields,
  };
}

/** A garment worn on `days` days, last `since` days ago, costing `price`. */
function worn(days: number, price: string | null = null, since = 1) {
  return garment({
    wearDays: days,
    recentWearDays: days,
    lastWorn: '2026-09-25',
    daysSinceWorn: since,
    price,
  });
}

describe('wardrobeInsights', () => {
  it('an empty closet is zeros, never a division by zero', () => {
    const insights = wardrobeInsights([], [], 90);
    expect(insights.worn.map((w) => w.percent)).toEqual([0, 0, 0]);
    expect(insights.cost.closetValue).toBe('0.00');
    expect(insights.colours).toEqual([]);
    expect(insights.categories).toEqual([]);
  });

  it('a closet nobody wore: 0 % worn, no worn share, costs not divided', () => {
    const insights = wardrobeInsights(
      [garment({ price: '10', colors: ['red'] })],
      [],
      90,
    );
    expect(insights.worn.every((w) => w.worn === 0)).toBe(true);
    expect(insights.colours).toEqual([{ colour: 'red', closet: 100, worn: 0 }]);
    expect(insights.cost.notWornYet[0].perWear).toBeNull();
    expect(insights.cost.best).toEqual([]);
  });

  it.each([
    [1, 1, 0],
    [2, 1, 1],
    [3, 2, 1],
    [11, RANKED_LIMIT, RANKED_LIMIT],
  ])(
    'cost per wear over %i worn garments: %i best, %i worst, none in both',
    (count, best, worst) => {
      const garments = Array.from({ length: count }, (_, i) =>
        worn(i + 1, '100'),
      );
      const { cost } = wardrobeInsights(garments, [], 90);
      expect(cost.best).toHaveLength(best);
      expect(cost.worst).toHaveLength(worst);
      const bestIds = cost.best.map((c) => c.garment.id);
      expect(cost.worst.some((c) => bestIds.includes(c.garment.id))).toBe(
        false,
      );
      // Best: most wears first (lowest cost per wear); worst: fewest first.
      expect(cost.best[0].garment.wearDays).toBe(count);
      if (worst > 0) expect(cost.worst[0].garment.wearDays).toBe(1);
    },
  );

  it('cost per wear rounds to the cent', () => {
    const { cost } = wardrobeInsights([worn(3, '10')], [], 90);
    expect(cost.best[0]).toMatchObject({ cost: '10.00', perWear: '3.33' });
  });

  it(`names the first ${BRANDS_LIMIT} brands and sums the rest`, () => {
    const garments = Array.from({ length: BRANDS_LIMIT + 2 }, (_, i) =>
      garment({ brand: `Brand ${i}`, recentWearDays: 1 }),
    );
    garments.push(garment({ brand: 'brand 0 ' }));
    const { brands, unbranded } = wardrobeInsights(garments, [], 90);
    expect(brands).toHaveLength(BRANDS_LIMIT + 1);
    expect(brands[0]).toMatchObject({ key: 'Brand 0', garments: 2 });
    expect(brands.at(-1)).toMatchObject({
      key: null,
      garments: 2,
      pieces: 2,
      recentWearDays: 2,
    });
    expect(unbranded).toBe(0);
  });

  it('drops a pair whose garment left the closet', () => {
    const a = worn(3);
    const { pairs } = wardrobeInsights([a], [{ a: a.id, b: 999, days: 3 }], 90);
    expect(pairs).toEqual([]);
  });
});
