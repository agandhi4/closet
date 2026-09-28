import { describe, expect, it } from 'vitest';
import {
  isImageVariant,
  newVariantKey,
  parseStoredName,
  variantFileName,
} from './image-variant';

describe('variantFileName', () => {
  it('returns the file name unchanged for the original', () => {
    expect(variantFileName('abc.webp', 'original')).toBe('abc.webp');
  });

  it('suffixes the base name before the extension', () => {
    expect(variantFileName('abc.webp', 'nobg')).toBe('abc-nobg.webp');
    expect(variantFileName('abc.webp', 'thumb')).toBe('abc-thumb.webp');
  });

  it('appends the suffix when there is no extension', () => {
    expect(variantFileName('abc', 'nobg')).toBe('abc-nobg');
  });

  it('only splits on the last dot', () => {
    expect(variantFileName('a.b.webp', 'thumb')).toBe('a.b-thumb.webp');
  });

  it('adds a variant key to nobg and thumb, never to the original', () => {
    expect(variantFileName('abc.webp', 'nobg', '0123456789ab')).toBe(
      'abc-nobg-0123456789ab.webp',
    );
    expect(variantFileName('abc.webp', 'thumb', '0123456789ab')).toBe(
      'abc-thumb-0123456789ab.webp',
    );
    expect(variantFileName('abc.webp', 'original', '0123456789ab')).toBe(
      'abc.webp',
    );
  });
});

describe('parseStoredName', () => {
  const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e';

  it('reads the original and unkeyed variants', () => {
    expect(parseStoredName(`${uuid}.webp`)).toEqual({
      baseName: `${uuid}.webp`,
      variant: 'original',
      variantKey: null,
    });
    expect(parseStoredName(`${uuid}-thumb.webp`)).toEqual({
      baseName: `${uuid}.webp`,
      variant: 'thumb',
      variantKey: null,
    });
  });

  it('reads a keyed variant back to its base name and key', () => {
    const key = newVariantKey();
    expect(
      parseStoredName(variantFileName(`${uuid}.webp`, 'nobg', key)),
    ).toEqual({ baseName: `${uuid}.webp`, variant: 'nobg', variantKey: key });
  });

  it('refuses anything else', () => {
    expect(parseStoredName('app.log')).toBeUndefined();
    expect(parseStoredName(`${uuid}-nobg-short.webp`)).toBeUndefined();
    // A key belongs to a variant, never to the original.
    expect(parseStoredName(`${uuid}-0123456789ab.webp`)).toBeUndefined();
  });
});

describe('newVariantKey', () => {
  it('is 12 hex digits, fresh each time', () => {
    const keys = new Set(Array.from({ length: 50 }, () => newVariantKey()));
    expect(keys.size).toBe(50);
    for (const key of keys) expect(key).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('isImageVariant', () => {
  it('accepts the three known variants', () => {
    expect(isImageVariant('original')).toBe(true);
    expect(isImageVariant('nobg')).toBe(true);
    expect(isImageVariant('thumb')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isImageVariant('watermark')).toBe(false);
    expect(isImageVariant('')).toBe(false);
  });
});
