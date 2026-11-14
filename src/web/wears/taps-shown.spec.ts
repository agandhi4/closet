import { describe, expect, it } from 'vitest';
import { NEVER_WASH } from '../../wardrobe/availability';
import { tapsShown } from './wear-section';

describe('tapsShown', () => {
  const tee = { category: 'tops', washAfterWears: 1 };

  it('offers both taps for a wear since a wash that is due', () => {
    expect(tapsShown(tee, { today: null, sinceWash: 1 })).toEqual({
      wear: true,
      wash: true,
    });
  });

  it('keeps Wore today (its undo) for a single wear today', () => {
    expect(tapsShown(tee, { today: 'single', sinceWash: 1 }).wear).toBe(true);
  });

  it('drops Wore today once a worn calendar entry wore it', () => {
    expect(tapsShown(tee, { today: 'entry', sinceWash: 1 })).toEqual({
      wear: false,
      wash: true,
    });
  });

  it('offers no Washed with nothing worn since a wash', () => {
    expect(tapsShown(tee, { today: null, sinceWash: 0 }).wash).toBe(false);
  });

  it('offers no Washed for a garment that is never washed', () => {
    const never = { ...tee, washAfterWears: NEVER_WASH };
    expect(tapsShown(never, { today: 'single', sinceWash: 3 }).wash).toBe(
      false,
    );
  });
});
