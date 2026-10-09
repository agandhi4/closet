import { describe, expect, it } from 'vitest';
import { collagePieces, outfitLabel, type PieceMarking } from './collage';

/**
 * How a collage marks an outfit's pieces (#358): to-buy everywhere; the
 * blocking marks (archived, away) and the wash only where it warns, and
 * away and the wash only to the owner (garmentMarks' gate).
 */
describe('collagePieces', () => {
  const garments = [
    { name: 'Wanted', category: 'tops', photo: null, status: 'wishlist' },
    { name: 'Old', category: 'tops', photo: null, status: 'archived' },
    {
      name: 'Lent',
      category: 'outerwear',
      photo: null,
      status: 'closet',
      away: 'lent',
    },
    {
      name: 'Dirty',
      category: 'tops',
      photo: null,
      status: 'closet',
      needsWash: true,
    },
  ] as const;
  const marks = (marking: PieceMarking) =>
    collagePieces(garments, marking).map((piece) => piece.marks);

  it('marks only a piece to buy where it does not warn', () => {
    expect(marks({ warn: false })).toEqual([['to-buy'], [], [], []]);
  });

  it('warns the owner of every blocking mark and the wash', () => {
    expect(marks({ warn: true, ownerView: true })).toEqual([
      ['to-buy'],
      ['archived'],
      ['away:lent'],
      ['needs-wash'],
    ]);
  });

  it('never shows a viewer away or the wash', () => {
    expect(marks({ warn: true, ownerView: false })).toEqual([
      ['to-buy'],
      ['archived'],
      [],
      [],
    ]);
  });
});

describe('outfitLabel', () => {
  const piece = { photo: null, category: 'outerwear' };

  it('keeps the bare name when no piece has a mark', () => {
    expect(outfitLabel('Look', [{ ...piece, name: 'Coat', marks: [] }])).toBe(
      'Look',
    );
  });

  it('names an unnamed marked piece by its translated category', () => {
    expect(
      outfitLabel('Look', [{ ...piece, name: null, marks: ['away:lent'] }]),
    ).toBe('Look: Outerwear (Lent)');
  });
});
