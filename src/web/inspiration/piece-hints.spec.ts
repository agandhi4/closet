import { describe, expect, it } from 'vitest';
import { pieceHints } from './piece-hints';

describe('pieceHints', () => {
  it('reads each garment a title lists, with its own colours', () => {
    expect(pieceHints('Navy blazer, white tee and black jeans', [])).toEqual([
      { role: 'layer', type: 'blazer', colors: ['blue'], pattern: null },
      { role: 'top', type: 't-shirt', colors: ['white'], pattern: null },
      { role: 'bottom', type: 'jeans', colors: ['black'], pattern: null },
    ]);
  });

  it('offers nothing the look already has, nothing twice, and nothing a title does not name', () => {
    const blazer = {
      role: 'layer',
      type: 'blazer',
      colors: [],
      pattern: null,
    } as const;
    expect(pieceHints('Navy blazer with white tee', [blazer])).toEqual([
      { role: 'top', type: 't-shirt', colors: ['white'], pattern: null },
    ]);
    expect(pieceHints('Tee + tee', [])).toHaveLength(1);
    expect(pieceHints('Paris, spring 2026', [])).toEqual([]);
    expect(pieceHints(null, [])).toEqual([]);
    // "sandals" holds "and" but is not split.
    expect(pieceHints('Tan sandals', [])).toEqual([
      { role: 'footwear', type: 'sandals', colors: ['beige'], pattern: null },
    ]);
  });
});
