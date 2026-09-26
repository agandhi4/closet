import { describe, expect, it } from 'vitest';
import {
  ALL_GARMENT_TYPES,
  CONDITIONS,
  FITS,
  FORMALITIES,
  LENGTHS,
  MATERIALS,
  PATTERNS,
  SLEEVES,
  WARMTHS,
} from '../../wardrobe/properties';
import { fabricWeightLabel, type LabelledProperty, valueLabel } from './labels';

// tKey throws on a missing string, so a value added to a set without its
// label would be a 500 on the first page that shows it. This is the guard.
const SETS: [LabelledProperty, readonly (string | number)[]][] = [
  ['type', ALL_GARMENT_TYPES],
  ['warmth', WARMTHS],
  ['formality', FORMALITIES],
  ['materials', MATERIALS],
  ['pattern', PATTERNS],
  ['fit', FITS],
  ['sleeve', SLEEVES],
  ['length', LENGTHS],
  ['condition', CONDITIONS],
];

describe('property labels', () => {
  it.each(SETS)('has a string for every %s value', (property, values) => {
    for (const value of values) {
      expect(valueLabel(property, value)).toMatch(/\S/);
    }
  });

  it('reads a scale in words', () => {
    expect(valueLabel('warmth', 3)).toBe('Medium');
    expect(valueLabel('formality', 4)).toBe('Dressy');
    expect(valueLabel('type', 't-shirt')).toBe('T-shirt');
  });

  it('shows a fabric weight in both units', () => {
    expect(fabricWeightLabel(203)).toBe('6 oz · 203 gsm');
  });

  it('refuses a value it has no string for', () => {
    expect(() => valueLabel('warmth', 9)).toThrow(/property\.warmth\.9/);
  });
});
