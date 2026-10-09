import { describe, expect, it } from 'vitest';
import type { GarmentMarkKind } from '../../wardrobe/marks';
import type { CollagePieceView } from '../outfits/collage';
import { hiddenBlocking } from './month-cell';

const piece = (marks: GarmentMarkKind[] = []): CollagePieceView => ({
  name: 'Piece',
  category: 'tops',
  photo: null,
  marks,
});

describe('hiddenBlocking', () => {
  it('finds a side piece the cell leaves out', () => {
    const top = piece();
    const bag = piece(['away:lent']);
    expect(hiddenBlocking([{ pieces: [top, bag] }], [top])).toBe('away:lent');
  });

  it("finds a later entry's piece", () => {
    const top = piece();
    const later = piece(['archived']);
    expect(
      hiddenBlocking([{ pieces: [top] }, { pieces: [later] }], [top]),
    ).toBe('archived');
  });

  it('adds nothing for a drawn piece, which keeps its own dot', () => {
    const lent = piece(['away:lent']);
    expect(hiddenBlocking([{ pieces: [lent] }], [lent])).toBeUndefined();
  });

  it('ignores the wash and pieces without marks', () => {
    const top = piece();
    expect(
      hiddenBlocking(
        [{ pieces: [top, piece(['needs-wash']), piece()] }],
        [top],
      ),
    ).toBeUndefined();
  });
});
