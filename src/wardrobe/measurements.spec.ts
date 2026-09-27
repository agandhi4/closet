import { describe, expect, it } from 'vitest';
import { brandKey, brandSpelling } from './brands';
import { inUnit, lengthText, toCentimetres } from './measurements';

describe('lengths', () => {
  it('stores inches as cm to two decimals', () => {
    expect(toCentimetres(32, 'in')).toBe(81.28);
    expect(toCentimetres(32.25, 'in')).toBe(81.92);
    expect(toCentimetres(81.3, 'cm')).toBe(81.3);
  });

  it('shows quarter and half inches back as typed', () => {
    for (const inches of [30, 30.25, 30.5, 30.75, 15.5, 70, 118]) {
      expect(inUnit(toCentimetres(inches, 'in'), 'in')).toBe(inches);
    }
  });

  it('shows cm to one decimal, without trailing zeros', () => {
    expect(lengthText(81.28, 'cm')).toBe('81.3');
    expect(lengthText(178, 'cm')).toBe('178');
    expect(lengthText(81.28, 'in')).toBe('32');
  });
});

describe('brands', () => {
  it('spells a brand trimmed with single spaces', () => {
    expect(brandSpelling('  Red   Wing ')).toBe('Red Wing');
  });

  it('keys a brand whatever its case and spaces', () => {
    expect(brandKey(' UNIQLO ')).toBe(brandKey('uniqlo'));
    expect(brandKey('Red  Wing')).toBe(brandKey('red wing'));
    expect(brandKey('   ')).toBe('');
  });

  it('spells and keys an accent typed as a letter plus a mark like the one character', () => {
    expect(brandSpelling('Cafe\u0301')).toBe('Caf\u00e9');
    expect(brandKey('CAFE\u0301')).toBe(brandKey('caf\u00e9'));
  });

  it('keys a dotted capital I whether typed as one character or two', () => {
    expect(brandKey('\u0130pekyol')).toBe(brandKey('I\u0307pekyol'));
    expect(brandKey('\u0130PEKYOL')).toBe(brandKey('i\u0307pekyol'));
  });

  it('keys a sharp s like its capital and like ss', () => {
    expect(brandKey('Stra\u00dfe')).toBe(brandKey('STRA\u1e9eE'));
    expect(brandKey('Stra\u00dfe')).toBe(brandKey('STRASSE'));
  });
});
