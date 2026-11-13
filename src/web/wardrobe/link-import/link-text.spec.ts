import { describe, expect, it } from 'vitest';
import { clipText, isStorableLink, LINK_INPUT_MAX } from './link-text';

describe('isStorableLink', () => {
  it('counts UTF-8 bytes, the server field cap, not UTF-16 units', () => {
    const prefix = 'https://shop.test/';
    // Each é is one UTF-16 unit and two bytes.
    const fits = prefix + 'é'.repeat((LINK_INPUT_MAX - prefix.length) / 2);
    expect(fits.length).toBeLessThan(LINK_INPUT_MAX);
    expect(isStorableLink(fits)).toBe(true);
    expect(isStorableLink(`${fits}é`)).toBe(false);
  });
});

describe('clipText', () => {
  it('never leaves half of a surrogate pair', () => {
    const text = `ab\u{1F457}`;
    expect(clipText(text, 3)).toBe('ab');
    expect(clipText(text, 4)).toBe(text);
    expect(() => encodeURIComponent(clipText(text, 3))).not.toThrow();
  });
});
