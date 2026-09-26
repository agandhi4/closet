import { describe, expect, it } from 'vitest';
import { type ComparedGarment, compareWardrobes } from './compare';

let nextId = 1;
function garment(
  category: string,
  type: string | null,
  extra: Partial<ComparedGarment> = {},
): ComparedGarment {
  return {
    id: nextId++,
    name: `${type ?? category} ${nextId}`,
    category,
    type,
    brand: null,
    colors: [],
    price: null,
    sourceUrl: null,
    ...extra,
  };
}

describe('compareWardrobes', () => {
  it('finds what the shared wardrobe has and the requester lacks, most first', () => {
    const owned = [garment('tops', 't-shirt'), garment('bottoms', 'jeans')];
    const shared = [
      garment('tops', 't-shirt'),
      garment('footwear', 'boots'),
      garment('outerwear', 'overshirt'),
      garment('outerwear', 'overshirt'),
    ];
    const { gaps } = compareWardrobes(owned, shared);
    expect(gaps.map((group) => [group.role, group.kind])).toEqual([
      ['layer', 'overshirt'],
      ['footwear', 'boots'],
    ]);
    expect(gaps[0].shared).toHaveLength(2);
    expect(gaps[0].owned).toEqual([]);
  });

  it('lists kinds both hold, and those only the requester has', () => {
    const owned = [
      garment('tops', 't-shirt'),
      garment('tops', 't-shirt'),
      garment('bags', 'backpack'),
    ];
    const shared = [garment('tops', 't-shirt')];
    const result = compareWardrobes(owned, shared);
    expect(result.overlap).toHaveLength(1);
    expect(result.overlap[0]).toMatchObject({ role: 'top', kind: 't-shirt' });
    expect(result.overlap[0].owned).toHaveLength(2);
    expect(result.overlap[0].shared).toHaveLength(1);
    expect(result.onlyOwned.map((group) => group.kind)).toEqual(['backpack']);
  });

  it('groups an untyped or custom-category garment by its category', () => {
    const owned = [garment('tops', null)];
    const shared = [garment('tops', null), garment('swimwear', null)];
    const result = compareWardrobes(owned, shared);
    expect(result.overlap.map((group) => group.kind)).toEqual(['tops']);
    expect(result.gaps).toEqual([
      expect.objectContaining({ role: 'none', kind: 'swimwear' }),
    ]);
  });

  it('counts every role on both sides, zeros included', () => {
    const result = compareWardrobes(
      [garment('tops', 'shirt')],
      [garment('footwear', 'sneakers'), garment('tops', 'shirt')],
    );
    expect(result.counts.top).toEqual({ owned: 1, shared: 1 });
    expect(result.counts.footwear).toEqual({ owned: 0, shared: 1 });
    expect(result.counts['one-piece']).toEqual({ owned: 0, shared: 0 });
  });

  it('carries what a shopping conversation needs: brand, colours, price, link', () => {
    const shared = [
      garment('tops', 'shirt', {
        brand: 'Uniqlo',
        colors: ['blue'],
        price: '39.90',
        sourceUrl: 'https://shop.example/oxford',
      }),
    ];
    const [gap] = compareWardrobes([], shared).gaps;
    expect(gap.shared[0]).toMatchObject({
      brand: 'Uniqlo',
      colors: ['blue'],
      price: '39.90',
      sourceUrl: 'https://shop.example/oxford',
    });
  });

  it('is empty for two empty wardrobes', () => {
    const result = compareWardrobes([], []);
    expect(result.gaps).toEqual([]);
    expect(result.overlap).toEqual([]);
    expect(result.onlyOwned).toEqual([]);
  });
});
