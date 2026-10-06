import { describe, expect, it } from 'vitest';
import { fromCents, toCents } from './money';

describe('cents', () => {
  it('reads and writes the numeric column’s strings without a float’s error', () => {
    expect(toCents('49.90')).toBe(4990);
    expect(toCents('0.29')).toBe(29);
    expect(toCents('1299')).toBe(129_900);
    expect(fromCents(3 * toCents('0.10'))).toBe('0.30');
  });
});
