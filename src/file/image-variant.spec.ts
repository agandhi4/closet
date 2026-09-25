import { isImageVariant, variantFileName } from './image-variant';

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
