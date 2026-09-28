import { describe, expect, it } from 'vitest';
import {
  applyCarePresets,
  carePresetsFor,
  type CareLabel,
  repairTotal,
} from './care';
import { MATERIALS } from './properties';

const NONE: CareLabel = {
  careWash: null,
  careBleach: null,
  careDry: null,
  careIron: null,
  careDryClean: null,
};

describe('carePresetsFor', () => {
  it('reads a material as its usual label', () => {
    expect(carePresetsFor(['cotton'])).toEqual({
      careWash: 'warm',
      careBleach: 'non_chlorine',
      careDry: 'tumble',
      careIron: 'high',
    });
  });

  it('takes the most careful instruction of a blend', () => {
    // Cotton is warm and tumbled; wool is hand washed and dried flat.
    expect(carePresetsFor(['cotton', 'wool'])).toEqual({
      careWash: 'hand',
      careBleach: 'do_not_bleach',
      careDry: 'flat',
      careIron: 'low',
    });
  });

  it('leaves an instruction no material gives unset', () => {
    // Leather has no drying instruction of its own.
    expect(carePresetsFor(['leather']).careDry).toBeUndefined();
    expect(carePresetsFor(['leather', 'cotton']).careDry).toBe('tumble');
  });

  it('suggests nothing for no materials or only other', () => {
    expect(carePresetsFor([])).toEqual({});
    // toEqual reads an undefined instruction as absent.
    expect(carePresetsFor(['other'])).toEqual({});
  });

  it('never presets dry cleaning (only the label knows)', () => {
    for (const material of MATERIALS) {
      expect(carePresetsFor([material])).not.toHaveProperty('careDryClean');
    }
  });
});

describe('applyCarePresets', () => {
  it('fills what is unset from the materials', () => {
    expect(applyCarePresets(NONE, null, ['denim'])).toEqual({
      careWash: 'cold',
      careBleach: 'do_not_bleach',
      careDry: 'line',
      careIron: 'medium',
      careDryClean: null,
    });
  });

  it('moves what is still at the old materials’ presets, keeps a choice', () => {
    const cotton = applyCarePresets(NONE, null, ['cotton']);
    // The person chose a cold wash and dry cleaning.
    const chosen = {
      ...cotton,
      careWash: 'cold',
      careDryClean: 'only',
    } as const;
    expect(applyCarePresets(chosen, ['cotton'], ['silk'])).toEqual({
      careWash: 'cold',
      careBleach: 'do_not_bleach',
      careDry: 'flat',
      careIron: 'low',
      careDryClean: 'only',
    });
  });

  it('clears a preset the new materials do not give', () => {
    const cotton = applyCarePresets(NONE, null, ['cotton']);
    expect(applyCarePresets(cotton, ['cotton'], []).careWash).toBeNull();
  });
});

describe('repairTotal', () => {
  it('sums the costs given in cents', () => {
    expect(repairTotal(['0.10', '0.20', null])).toBe('0.30');
    expect(repairTotal(['25.00', '12.50'])).toBe('37.50');
  });

  it('is null when no entry gives a cost', () => {
    expect(repairTotal([])).toBeNull();
    expect(repairTotal([null, null])).toBeNull();
  });
});
