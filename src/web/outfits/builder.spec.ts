import { describe, expect, it } from 'vitest';
import {
  clampIndex,
  cycleRow,
  newOutfitRows,
  type RowGarment,
  savedOutfitRows,
} from './builder';

function garment(id: number, archived = false): RowGarment {
  return {
    id,
    name: `Garment ${id}`,
    brand: null,
    color: null,
    size: null,
    notes: null,
    archived,
    photo: null,
  };
}

const steps = (row: {
  index: number | null;
  prevIndex: number;
  nextIndex: number;
}) => [row.prevIndex, row.index, row.nextIndex];

describe('outfit builder rows', () => {
  it('cycles through "no garment" and back at both ends', () => {
    expect(steps(cycleRow('tops', 3, 0, null))).toEqual([3, 0, 1]);
    expect(steps(cycleRow('tops', 3, 1, garment(9)))).toEqual([0, 1, 2]);
    expect(steps(cycleRow('tops', 3, 3, garment(7)))).toEqual([2, 3, 0]);
    // An empty category only has "no garment".
    expect(steps(cycleRow('capes', 0, 0, null))).toEqual([0, 0, 0]);
  });

  it('clamps a requested position into the cycle, defaulting to the newest', () => {
    expect(clampIndex(undefined, 3)).toBe(1);
    expect(clampIndex(undefined, 0)).toBe(0);
    expect(clampIndex(-4, 3)).toBe(0);
    expect(clampIndex(99, 3)).toBe(3);
  });

  it('labels built-in categories in words and keeps custom ones as typed', () => {
    const [tops, hats] = newOutfitRows([
      { category: 'hats', count: 1, garment: garment(1) },
      { category: 'tops', count: 2, garment: garment(2) },
    ]);
    expect([tops.label, tops.index]).toEqual(['Tops', 1]);
    expect([hats.label, hats.index]).toEqual(['hats', 1]);
  });

  it('places a saved garment at its position in the cycle', () => {
    const [row] = savedOutfitRows([
      {
        category: 'tops',
        count: 4,
        newer: 2,
        garment: { ...garment(5), category: 'tops' },
      },
    ]);
    expect(steps(row)).toEqual([2, 3, 4]);
  });

  // Archived (or moved to another category): shown, but between cycle
  // positions, so each arrow leads to the nearest garment by age.
  it('puts a garment outside the cycle between its neighbours by age', () => {
    const outside = (newer: number, count: number) =>
      steps(
        savedOutfitRows([
          {
            category: 'tops',
            count,
            newer,
            garment: { ...garment(5, true), category: 'tops' },
          },
        ])[0],
      );
    expect(outside(1, 3)).toEqual([1, null, 2]);
    expect(outside(0, 3)).toEqual([0, null, 1]);
    expect(outside(3, 3)).toEqual([3, null, 0]);
    expect(outside(0, 0)).toEqual([0, null, 0]);

    const [moved] = savedOutfitRows([
      {
        category: 'tops',
        count: 2,
        newer: 1,
        garment: { ...garment(5), category: 'shirts' },
      },
    ]);
    expect(moved.index).toBeNull();
    expect(moved.garment?.id).toBe(5);
  });

  it('keeps an empty saved slot as "no garment"', () => {
    const [row] = savedOutfitRows([
      { category: 'footwear', count: 2, newer: 0, garment: null },
    ]);
    expect(steps(row)).toEqual([2, 0, 1]);
  });
});
