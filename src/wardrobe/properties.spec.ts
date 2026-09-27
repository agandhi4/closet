import { describe, expect, it } from 'vitest';
import {
  ALL_GARMENT_TYPES,
  applyPresets,
  categoryRole,
  FORMALITIES,
  GARMENT_TYPES,
  GarmentCategory,
  gsmToOz,
  LENGTHS,
  MATERIALS,
  ozToGsm,
  type PresetValues,
  presetsFor,
  propertyApplies,
  SLEEVES,
  storedSet,
  typesOf,
  WARMTHS,
} from './properties';

const UNSET: PresetValues = {
  warmth: null,
  formality: null,
  sleeve: null,
  length: null,
  waterResistant: false,
};

const tee = (fabricWeight: number | null = null) => ({
  category: 'tops',
  type: 't-shirt',
  fabricWeight,
});

describe('garment roles', () => {
  it('gives each built-in category its role, and every other category none', () => {
    expect(categoryRole('tops')).toBe('top');
    expect(categoryRole('dresses')).toBe('one-piece');
    expect(categoryRole('outerwear')).toBe('layer');
    expect(categoryRole('bags')).toBe('bag');
    expect(categoryRole('other')).toBe('none');
    expect(categoryRole('hats')).toBe('none');
  });

  it('offers only the properties a role has', () => {
    expect(propertyApplies('sleeve', 'tops')).toBe(true);
    expect(propertyApplies('sleeve', 'footwear')).toBe(false);
    expect(propertyApplies('length', 'bottoms')).toBe(true);
    expect(propertyApplies('waterResistant', 'tops')).toBe(false);
    expect(propertyApplies('waterResistant', 'outerwear')).toBe(true);
    expect(propertyApplies('fabricWeight', 'footwear')).toBe(false);
  });

  it('offers a type only where the category has types', () => {
    expect(propertyApplies('type', 'tops')).toBe(true);
    expect(propertyApplies('type', 'other')).toBe(false);
    expect(propertyApplies('type', 'hats')).toBe(false);
    expect(typesOf('hats')).toEqual([]);
  });

  it('gives a custom category the general properties', () => {
    for (const property of [
      'warmth',
      'formality',
      'materials',
      'pattern',
    ] as const) {
      expect(propertyApplies(property, 'hats')).toBe(true);
    }
  });
});

describe('the type table', () => {
  const entries = Object.entries(GARMENT_TYPES).flatMap(([category, types]) =>
    types.map((type) => ({ category, type })),
  );

  it('lists each type once within its category', () => {
    for (const types of Object.values(GARMENT_TYPES)) {
      const values = types.map((type) => type.value);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it('presets only legal values, and only properties the category has', () => {
    for (const { category, type } of entries) {
      const { warmth, formality, sleeve, length, waterResistant } =
        type.presets;
      if (warmth !== undefined) {
        expect(WARMTHS).toContain(warmth);
        expect(propertyApplies('warmth', category)).toBe(true);
      }
      if (formality !== undefined) expect(FORMALITIES).toContain(formality);
      if (sleeve !== undefined) {
        expect(SLEEVES).toContain(sleeve);
        expect(propertyApplies('sleeve', category)).toBe(true);
      }
      if (length !== undefined) {
        expect(LENGTHS).toContain(length);
        expect(propertyApplies('length', category)).toBe(true);
      }
      if (waterResistant !== undefined) {
        expect(propertyApplies('waterResistant', category)).toBe(true);
      }
    }
  });

  it('lists weight steps heaviest first, ending at zero, on types that have a weight', () => {
    for (const { category, type } of entries) {
      if (!type.weightSteps) continue;
      expect(propertyApplies('fabricWeight', category)).toBe(true);
      const minimums = type.weightSteps.map((step) => step.minGsm);
      expect(minimums).toEqual([...minimums].sort((a, b) => b - a));
      expect(minimums.at(-1)).toBe(0);
    }
  });

  it('gives the check constraint every type exactly once', () => {
    expect(new Set(ALL_GARMENT_TYPES).size).toBe(ALL_GARMENT_TYPES.length);
    expect(ALL_GARMENT_TYPES).toContain('t-shirt');
    expect(GARMENT_TYPES[GarmentCategory.OTHER]).toEqual([]);
  });
});

describe('fabric weight', () => {
  it('converts a 6 oz heavyweight tee to 203 gsm and back', () => {
    expect(ozToGsm(6)).toBe(203);
    expect(gsmToOz(203)).toBe(6);
    expect(gsmToOz(240)).toBe(7.1);
  });

  it('makes a heavier tee warmer, and leaves a type without weight steps alone', () => {
    expect(presetsFor(tee()).warmth).toBe(2);
    expect(presetsFor(tee(ozToGsm(4.5))).warmth).toBe(2);
    expect(presetsFor(tee(ozToGsm(6))).warmth).toBe(3);
    expect(presetsFor(tee(100)).warmth).toBe(1);
    expect(
      presetsFor({ category: 'tops', type: 'shirt', fabricWeight: 300 }).warmth,
    ).toBe(2);
  });

  it('knows no presets for an unknown or mismatched type', () => {
    expect(
      presetsFor({ category: 'bottoms', type: 't-shirt', fabricWeight: null }),
    ).toEqual({});
    expect(
      presetsFor({ category: 'hats', type: null, fabricWeight: null }),
    ).toEqual({});
  });
});

describe('applyPresets', () => {
  it('fills an untouched form from the chosen type', () => {
    expect(applyPresets(UNSET, null, tee())).toEqual({
      ...UNSET,
      warmth: 2,
      formality: 2,
      sleeve: 'short',
    });
  });

  it('follows a new type where the values were still the old presets', () => {
    const fromTee = applyPresets(UNSET, null, tee());
    expect(
      applyPresets(fromTee, tee(), {
        category: 'tops',
        type: 'sweater',
        fabricWeight: null,
      }),
    ).toEqual({ ...UNSET, warmth: 4, formality: 3, sleeve: 'long' });
  });

  it('never replaces a value the user chose', () => {
    const chosen = {
      ...UNSET,
      warmth: 5 as const,
      formality: 2 as const,
      sleeve: 'short' as const,
    };
    const next = applyPresets(chosen, tee(), {
      category: 'tops',
      type: 'sweater',
      fabricWeight: null,
    });
    expect(next.warmth).toBe(5);
    // formality 2 and sleeve short were the tee's presets: they follow.
    expect(next.formality).toBe(3);
    expect(next.sleeve).toBe('long');
  });

  it('warms a tee when its weight reaches heavyweight, unless warmth was chosen', () => {
    const light = applyPresets(UNSET, null, tee());
    expect(applyPresets(light, tee(), tee(203)).warmth).toBe(3);
    const chosen = { ...light, warmth: 1 as const };
    expect(applyPresets(chosen, tee(), tee(203)).warmth).toBe(1);
  });

  it('clears presets the new type does not have', () => {
    const fromTee = applyPresets(UNSET, null, tee());
    expect(
      applyPresets(fromTee, tee(), {
        category: 'bottoms',
        type: null,
        fabricWeight: null,
      }),
    ).toEqual(UNSET);
  });

  it('sets and clears water resistance with the type, and keeps a chosen one', () => {
    const rain = {
      category: 'outerwear',
      type: 'rain-jacket',
      fabricWeight: null,
    };
    const blazer = {
      category: 'outerwear',
      type: 'blazer',
      fabricWeight: null,
    };
    const fromRain = applyPresets(UNSET, null, rain);
    expect(fromRain.waterResistant).toBe(true);
    expect(applyPresets(fromRain, rain, blazer).waterResistant).toBe(false);
    const chosen = applyPresets(
      { ...UNSET, waterResistant: true },
      null,
      blazer,
    );
    expect(chosen.waterResistant).toBe(true);
  });
});

describe('storedSet', () => {
  it('stores a set in its list’s order, each once', () => {
    expect(storedSet(MATERIALS, ['wool', 'cotton', 'wool'])).toEqual([
      'cotton',
      'wool',
    ]);
  });

  it('drops values outside the list, and stores none as null', () => {
    expect(storedSet(MATERIALS, ['vinyl', 'denim'])).toEqual(['denim']);
    expect(storedSet(MATERIALS, ['vinyl'])).toBeNull();
    expect(storedSet(MATERIALS, [])).toBeNull();
  });
});
