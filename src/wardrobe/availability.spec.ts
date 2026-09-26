import { describe, expect, it } from 'vitest';
import {
  cleanCopies,
  defaultWashAfter,
  defaultWashAfterByCategory,
  dirtyCopies,
  isAvailable,
  needsWash,
  NEVER_WASH,
  washLimit,
  wearsSinceWash,
  type WashState,
} from './availability';

const state = (
  wearsSinceWash: number,
  limit: number | null,
  quantity = 1,
): WashState => ({ wearsSinceWash, limit, quantity });

describe('wash limits', () => {
  it('defaults by role: tops and dresses 1, bottoms 3, layers 10, the rest never', () => {
    expect(defaultWashAfter('tops')).toBe(1);
    expect(defaultWashAfter('dresses')).toBe(1);
    expect(defaultWashAfter('bottoms')).toBe(3);
    expect(defaultWashAfter('outerwear')).toBe(10);
    for (const category of ['footwear', 'accessories', 'bags', 'other']) {
      expect(defaultWashAfter(category)).toBeNull();
    }
    // A custom category is role none.
    expect(defaultWashAfter('scrubs')).toBeNull();
  });

  it('takes the garment’s own setting over its role, and NEVER_WASH as never', () => {
    expect(washLimit('tops', null)).toBe(1);
    expect(washLimit('tops', 2)).toBe(2);
    expect(washLimit('bottoms', NEVER_WASH)).toBeNull();
    // Socks are accessories (never by default) but a setting reaches them.
    expect(washLimit('accessories', 1)).toBe(1);
  });

  it('lists the defaults as data for the SQL form, with nothing that is never', () => {
    expect(new Map(defaultWashAfterByCategory())).toEqual(
      new Map([
        ['outerwear', 10],
        ['dresses', 1],
        ['tops', 1],
        ['bottoms', 3],
      ]),
    );
  });
});

describe('wears since the last wash', () => {
  it('counts distinct days: two entries on one day are one wear', () => {
    expect(
      wearsSinceWash(['2026-09-21', '2026-09-21', '2026-09-22'], null),
    ).toBe(2);
  });

  it('counts every wear of a garment never washed', () => {
    expect(wearsSinceWash(['2026-01-02', '2026-05-09'], null)).toBe(2);
  });

  it('counts a wear on the wash day as before the wash', () => {
    const days = ['2026-09-20', '2026-09-20', '2026-09-21'];
    expect(wearsSinceWash(days, '2026-09-20')).toBe(1);
    expect(wearsSinceWash(['2026-09-20'], '2026-09-20')).toBe(0);
  });
});

describe('the threshold rule', () => {
  it('needs a wash when the wears reach the limit, not before', () => {
    // Jeans: limit 3.
    expect(needsWash(state(2, 3))).toBe(false);
    expect(needsWash(state(3, 3))).toBe(true);
    expect(needsWash(state(4, 3))).toBe(true);
    // A tee: one wear.
    expect(needsWash(state(0, 1))).toBe(false);
    expect(needsWash(state(1, 1))).toBe(true);
  });

  it('never needs a wash without a limit', () => {
    expect(needsWash(state(40, null))).toBe(false);
    expect(dirtyCopies(state(40, null, 2))).toBe(0);
  });
});

describe('multiples', () => {
  it('uses up one copy per `limit` wears: three white tees last three wears', () => {
    expect([0, 1, 2, 3].map((w) => cleanCopies(state(w, 1, 3)))).toEqual([
      3, 2, 1, 0,
    ]);
    expect([0, 1, 2, 3].map((w) => dirtyCopies(state(w, 1, 3)))).toEqual([
      0, 1, 2, 3,
    ]);
  });

  it('dirties a copy only once it reaches its limit', () => {
    // Two pairs of jeans at 3: the second pair starts on the fourth wear.
    expect([2, 3, 5, 6].map((w) => dirtyCopies(state(w, 3, 2)))).toEqual([
      0, 1, 1, 2,
    ]);
  });

  it('caps the dirty copies at the quantity', () => {
    expect(dirtyCopies(state(9, 1, 3))).toBe(3);
    expect(cleanCopies(state(9, 1, 3))).toBe(0);
  });

  it('needs a wash as soon as one copy does', () => {
    expect(needsWash(state(1, 1, 3))).toBe(true);
  });
});

describe('isAvailable', () => {
  const garment = {
    ...state(0, 1, 1),
    archived: false,
    away: null,
  } as const;

  it('is available in the closet with a clean copy', () => {
    expect(isAvailable(garment)).toBe(true);
    // Two of three tees dirty: the third is still there.
    expect(isAvailable({ ...garment, ...state(2, 1, 3) })).toBe(true);
    // Shoes never get dirty.
    expect(isAvailable({ ...garment, ...state(30, null) })).toBe(true);
  });

  it('excludes a dirty garment, one lent or at the repair shop, and an archived one', () => {
    expect(isAvailable({ ...garment, ...state(1, 1) })).toBe(false);
    expect(isAvailable({ ...garment, ...state(3, 1, 3) })).toBe(false);
    expect(isAvailable({ ...garment, away: 'lent' })).toBe(false);
    expect(isAvailable({ ...garment, away: 'repair' })).toBe(false);
    expect(isAvailable({ ...garment, archived: true })).toBe(false);
  });
});
