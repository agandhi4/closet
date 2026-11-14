import { describe, expect, it } from 'vitest';
import { renderToString } from '../render';
import {
  collagePieces,
  OutfitCollage,
  outfitLabel,
  type CollageSize,
  type PieceMarking,
} from './collage';

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

/**
 * A layer and a top share the upper row (#663): at every size each piece
 * may shrink below its natural width, or the pair spills out of a narrow
 * frame (a 48 px month cell). The browser's bounding-box check is
 * test/calendar.spec.ts; this holds the markup at each size.
 */
describe('OutfitCollage with two upper pieces', () => {
  const layered = [
    { name: 'Coat', category: 'outerwear', photo: null },
    { name: 'Tee', category: 'tops', photo: null },
  ];

  it.each<CollageSize>(['thumb', 'cell', 'card', 'tile'])(
    'lets both pieces shrink in a %s',
    async (size) => {
      const html = await renderToString(
        <OutfitCollage garments={layered} size={size} />,
      );
      const pieces = html.match(/<span[^>]*data-collage-piece[^>]*>/g) ?? [];
      expect(pieces).toHaveLength(2);
      for (const piece of pieces) expect(piece).toContain('min-w-0');
      expect(html).toContain(`data-collage="${size}"`);
    },
  );
});
