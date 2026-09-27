import { describe, expect, it } from 'vitest';
import { NEVER_WASH } from './availability';
import {
  copiesNeeded,
  type GarmentUse,
  type PackingGarment,
  packingList,
  tripPhase,
  tripWears,
} from './packing';

const TRIP = { startsOn: '2026-10-05', endsOn: '2026-10-09' };
const BEFORE = '2026-10-01';

/** The trip's days, 5 of them. */
const DAYS = [
  '2026-10-05',
  '2026-10-06',
  '2026-10-07',
  '2026-10-08',
  '2026-10-09',
];

const garment = (
  id: number,
  category: string,
  overrides: Partial<PackingGarment> = {},
): PackingGarment => ({
  id,
  category,
  quantity: 1,
  washAfterWears: null,
  wearsSinceWash: 0,
  status: 'closet',
  away: null,
  ...overrides,
});

/** `n` uses on each of `days`: n outfits a day holding the garment (occasions). */
const usesOn = (days: readonly string[], perDay = 1): GarmentUse[] =>
  days.flatMap((day) => Array.from({ length: perDay }, () => ({ day })));

const unassigned = (n: number): GarmentUse[] =>
  Array.from({ length: n }, () => ({ day: null }));

describe('trip wears (one wear per garment per day)', () => {
  it('counts each day once, however many occasions that day hold it', () => {
    // Daytime and dinner on each of 5 days: 5 wears, not 10.
    expect(tripWears(usesOn(DAYS, 2))).toBe(5);
    // Workout, work and evening on one day: one wear.
    expect(tripWears(usesOn(DAYS.slice(0, 1), 3))).toBe(1);
  });

  it('counts an outfit without a day as a wear of its own', () => {
    expect(tripWears(unassigned(3))).toBe(3);
    expect(tripWears([...usesOn(DAYS.slice(0, 2)), ...unassigned(2)])).toBe(4);
  });

  it('is nothing without uses', () => {
    expect(tripWears([])).toBe(0);
  });
});

describe('copies needed (days × occasions, k, quantity)', () => {
  // [what, uses, wash limit k, copies needed]
  const cases: [string, GarmentUse[], number | null, number][] = [
    ['a tee (k = 1), one outfit a day for 5 days', usesOn(DAYS), 1, 5],
    [
      'a tee (k = 1), day and dinner for 5 days: still 5',
      usesOn(DAYS, 2),
      1,
      5,
    ],
    ['a tee (k = 1), 2 days of 3 occasions', usesOn(DAYS.slice(0, 2), 3), 1, 2],
    ['jeans (k = 3), day and dinner for 5 days', usesOn(DAYS, 2), 3, 2],
    ['jeans (k = 3), 3 days: exactly one copy', usesOn(DAYS.slice(0, 3)), 3, 1],
    ['jeans (k = 3), 4 days: a second copy', usesOn(DAYS.slice(0, 4)), 3, 2],
    ['a sweater (k = 2), 5 days', usesOn(DAYS), 2, 3],
    ['a jacket (k = 10), 5 days', usesOn(DAYS), 10, 1],
    ['shoes (never washed), 5 days of 2 occasions', usesOn(DAYS, 2), null, 1],
    ['a tee in 3 outfits without a day', unassigned(3), 1, 3],
    [
      'a tee, 2 days and 2 outfits without a day',
      [...usesOn(DAYS.slice(0, 2)), ...unassigned(2)],
      1,
      4,
    ],
    ['anything worn on no day of it', [], 1, 0],
  ];
  it.each(cases)('%s', (_, uses, limit, needed) => {
    expect(copiesNeeded(tripWears(uses), limit)).toBe(needed);
  });

  it('packs what is owned and says how many are missing', () => {
    // Three white tees for a 5-day trip of one outfit a day.
    const list = packingList({
      garments: [garment(1, 'tops', { quantity: 3 })],
      uses: new Map([[1, usesOn(DAYS)]]),
      packed: new Set(),
      trip: TRIP,
      today: BEFORE,
    });
    const [row] = list.groups[0].rows;
    expect(row).toMatchObject({ wears: 5, needed: 5, pack: 3, outfits: 5 });
    expect(row.warnings).toEqual([{ kind: 'too-few', short: 2 }]);
    expect(list.pieces).toBe(3);
  });

  it('asks nothing more when the quantity covers the trip', () => {
    const list = packingList({
      garments: [garment(1, 'tops', { quantity: 6 })],
      uses: new Map([[1, usesOn(DAYS, 2)]]),
      packed: new Set(),
      trip: TRIP,
      today: BEFORE,
    });
    expect(list.groups[0].rows[0]).toMatchObject({
      needed: 5,
      pack: 5,
      warnings: [],
    });
  });

  it('reads the garment’s own wash limit, never included', () => {
    const list = packingList({
      garments: [
        garment(1, 'bottoms', { washAfterWears: NEVER_WASH }),
        garment(2, 'bottoms', { washAfterWears: 1, quantity: 2 }),
      ],
      uses: new Map([
        [1, usesOn(DAYS)],
        [2, usesOn(DAYS.slice(0, 2))],
      ]),
      packed: new Set(),
      trip: TRIP,
      today: BEFORE,
    });
    expect(list.groups[0].rows.map((r) => [r.needed, r.pack])).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });
});

describe('packing list', () => {
  const garments = [
    garment(1, 'footwear'),
    garment(2, 'tops', { quantity: 3 }),
    garment(3, 'outerwear'),
    garment(4, 'bottoms'),
    garment(5, 'bags'),
    garment(6, 'tops'),
  ];
  const uses = new Map<number, GarmentUse[]>([
    [1, usesOn(DAYS)],
    [2, usesOn(DAYS.slice(0, 3))],
    [3, usesOn(DAYS.slice(0, 1))],
    [4, usesOn(DAYS)],
    [5, usesOn(DAYS)],
    // 6 is in no trip outfit: not on the list.
  ]);

  it('groups by role top to toe, keeping the given order within a role', () => {
    const list = packingList({
      garments,
      uses,
      packed: new Set([2, 5, 6]),
      trip: TRIP,
      today: BEFORE,
    });
    expect(
      list.groups.map((g) => [g.role, g.rows.map((r) => r.garment.id)]),
    ).toEqual([
      ['layer', [3]],
      ['top', [2]],
      ['bottom', [4]],
      ['footwear', [1]],
      ['bag', [5]],
    ]);
    // The mark for garment 6 is an orphan: not counted.
    expect(list).toMatchObject({ garments: 5, packed: 2 });
    expect(list.groups[1].rows[0].packed).toBe(true);
  });

  it('warns to wash a garment with too few clean copies, up to departure', () => {
    // Worn once since its wash: 2 of 3 tees clean, 3 to pack.
    const dirty = [garment(2, 'tops', { quantity: 3, wearsSinceWash: 1 })];
    const on = (today: string) =>
      packingList({
        garments: dirty,
        uses,
        packed: new Set(),
        trip: TRIP,
        today,
      }).groups[0].rows[0].warnings;
    expect(on(BEFORE)).toEqual([{ kind: 'wash', clean: 2 }]);
    expect(on(TRIP.startsOn)).toEqual([{ kind: 'wash', clean: 2 }]);
    // Under way: the bag is packed, the tees worn on the trip are no news.
    expect(on('2026-10-06')).toEqual([]);
  });

  it('asks no wash while enough clean copies are left', () => {
    const [row] = packingList({
      garments: [garment(2, 'tops', { quantity: 3, wearsSinceWash: 1 })],
      uses: new Map([[2, usesOn(DAYS.slice(0, 2))]]),
      packed: new Set(),
      trip: TRIP,
      today: BEFORE,
    }).groups[0].rows;
    expect(row.warnings).toEqual([]);
  });

  it('warns about a garment away or archived while the trip is ahead or on', () => {
    const list = (today: string) =>
      packingList({
        garments: [
          garment(1, 'footwear', { away: 'repair' }),
          garment(4, 'bottoms', { status: 'archived', quantity: 2 }),
        ],
        uses,
        packed: new Set(),
        trip: TRIP,
        today,
      });
    const warnings = (today: string) =>
      list(today).groups.flatMap((g) => g.rows.map((r) => r.warnings));
    expect(warnings('2026-10-07')).toEqual([
      [{ kind: 'archived' }],
      [{ kind: 'away', reason: 'repair' }],
    ]);
    expect(list(BEFORE).warned).toBe(2);
    // A finished trip's list is a record: no warnings.
    expect(warnings('2026-10-10')).toEqual([[], []]);
  });
});

describe('trip phase', () => {
  it('is upcoming before the first day, current through the last, then past', () => {
    expect(tripPhase(TRIP, '2026-10-04')).toBe('upcoming');
    expect(tripPhase(TRIP, TRIP.startsOn)).toBe('current');
    expect(tripPhase(TRIP, TRIP.endsOn)).toBe('current');
    expect(tripPhase(TRIP, '2026-10-10')).toBe('past');
  });
});
