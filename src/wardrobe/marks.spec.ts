import { describe, expect, it } from 'vitest';
import { AWAY_REASONS } from './availability';
import { GARMENT_MARKS, garmentMarks, type MarkedGarment } from './marks';
import { GARMENT_STATUSES } from './status';

const OWNER = { ownerView: true };
const VIEWER = { ownerView: false };

describe('garmentMarks', () => {
  it('marks a garment by its status: to buy, archived, nothing in the closet', () => {
    expect(garmentMarks({ status: 'wishlist' }, OWNER)).toEqual(['to-buy']);
    expect(garmentMarks({ status: 'archived' }, OWNER)).toEqual(['archived']);
    expect(garmentMarks({ status: 'closet' }, OWNER)).toEqual([]);
  });

  it('names each away reason', () => {
    for (const reason of AWAY_REASONS) {
      expect(garmentMarks({ status: 'closet', away: reason }, OWNER)).toEqual([
        `away:${reason}`,
      ]);
    }
    expect(
      garmentMarks({ status: 'closet', away: null, needsWash: false }, OWNER),
    ).toEqual([]);
  });

  it('orders status, then away, then the wash', () => {
    expect(
      garmentMarks(
        { status: 'archived', away: 'repair', needsWash: true },
        OWNER,
      ),
    ).toEqual(['archived', 'away:repair', 'needs-wash']);
    expect(
      garmentMarks({ status: 'closet', away: 'lent', needsWash: true }, OWNER),
    ).toEqual(['away:lent', 'needs-wash']);
  });

  it('a set-aside pick says so instead of to buy', () => {
    expect(garmentMarks({ status: 'wishlist', setAside: true }, OWNER)).toEqual(
      ['set-aside'],
    );
    expect(
      garmentMarks({ status: 'wishlist', setAside: false }, OWNER),
    ).toEqual(['to-buy']);
  });

  it('a bought or archived pick is no longer set aside', () => {
    expect(garmentMarks({ status: 'closet', setAside: true }, OWNER)).toEqual(
      [],
    );
    expect(garmentMarks({ status: 'archived', setAside: true }, OWNER)).toEqual(
      ['archived'],
    );
  });

  it('never shows a viewer of a shared wardrobe away or the wash', () => {
    const lentAndDirty = { away: 'lent', needsWash: true } as const;
    expect(garmentMarks({ status: 'closet', ...lentAndDirty }, VIEWER)).toEqual(
      [],
    );
    expect(
      garmentMarks({ status: 'archived', ...lentAndDirty }, VIEWER),
    ).toEqual(['archived']);
    expect(garmentMarks({ status: 'wishlist' }, VIEWER)).toEqual(['to-buy']);
  });

  it('always answers in GARMENT_MARKS order, without repeats', () => {
    const garments: MarkedGarment[] = GARMENT_STATUSES.flatMap((status) =>
      [null, ...AWAY_REASONS].flatMap((away) =>
        [false, true].flatMap((needsWash) =>
          [false, true].map((setAside) => ({
            status,
            away,
            needsWash,
            setAside,
          })),
        ),
      ),
    );
    for (const garment of garments) {
      const marks = garmentMarks(garment, OWNER);
      const ranks = marks.map((mark) => GARMENT_MARKS.indexOf(mark));
      expect(ranks).toEqual([...new Set(ranks)].sort((a, b) => a - b));
      expect(marks.includes('to-buy') && marks.includes('set-aside')).toBe(
        false,
      );
    }
  });
});
