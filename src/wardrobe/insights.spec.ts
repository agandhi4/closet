import { describe, expect, it } from 'vitest';
import {
  BRANDS_LIMIT,
  perWearCost,
  type InsightGarment,
  RANKED_LIMIT,
  totalCost,
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

  it('shares colours over the whole closet and every wear day, the uncoloured included (#123)', () => {
    const insights = wardrobeInsights(
      [
        garment({ colors: ['red'], recentWearDays: 3 }),
        garment({ colors: null, recentWearDays: 1 }),
      ],
      [],
      90,
    );
    expect(insights.colours).toEqual([{ colour: 'red', closet: 50, worn: 75 }]);
    expect(insights.uncoloured).toEqual({ garments: 1, closet: 50, worn: 25 });
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

describe('totalCost', () => {
  it('is the price of every copy plus the repairs, counted once', () => {
    expect(totalCost({ price: '12.50', quantity: 3, repairCost: null })).toBe(
      '37.50',
    );
    expect(totalCost({ price: '12.50', quantity: 3, repairCost: '0.10' })).toBe(
      '37.60',
    );
    expect(totalCost({ price: '0.10', quantity: 1, repairCost: '0.20' })).toBe(
      '0.30',
    );
  });

  it('is unknown without a price, whatever the repairs cost', () => {
    expect(
      totalCost({ price: null, quantity: 1, repairCost: '40.00' }),
    ).toBeNull();
  });
});

describe('perWearCost', () => {
  it('divides what the garment cost by its wear days, to the cent', () => {
    expect(perWearCost('350.00', 12)).toBe('29.17');
    expect(perWearCost('37.50', 5)).toBe('7.50');
  });

  it('never divides by no wears', () => {
    expect(perWearCost('80.00', 0)).toBeNull();
  });
});

describe('cost per wear with repairs (#151)', () => {
  it('ranks a repaired garment by what it cost in all', () => {
    // 100 over 10 wears is 10.00 a wear; the 60.00 resole makes it 16.00,
    // dearer than the 150.00 coat's 15.00.
    const boots = worn(10, '100');
    const repaired = { ...boots, repairCost: '60.00' };
    const coat = worn(10, '150');
    const { cost } = wardrobeInsights([repaired, coat], [], 90);
    expect(cost.best.map((c) => [c.garment.id, c.cost, c.perWear])).toEqual([
      [coat.id, '150.00', '15.00'],
    ]);
    expect(cost.worst.map((c) => [c.garment.id, c.cost, c.perWear])).toEqual([
      [boots.id, '160.00', '16.00'],
    ]);
    expect(cost.closetValue).toBe('310.00');
  });

  it('leaves an unpriced garment out, repaired or not', () => {
    const unpriced = { ...worn(4), repairCost: '30.00' };
    const { cost } = wardrobeInsights([unpriced], [], 90);
    expect(cost).toMatchObject({ priced: 0, unpriced: 1, closetValue: '0.00' });
    expect(cost.best).toEqual([]);
  });
});
