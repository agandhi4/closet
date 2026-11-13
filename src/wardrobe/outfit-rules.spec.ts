import { describe, expect, it } from 'vitest';
import { type StoredMatcher, storedMatcher } from './outfit-rules';
import { GarmentCategory } from './properties';

const none: StoredMatcher = {
  garmentId: null,
  category: null,
  type: null,
  color: null,
  pattern: null,
};

describe('storedMatcher', () => {
  // outfit_rule keeps one matcher per side as nullable columns; the
  // generator reads it as the union, each shape once.
  it('reads each stored side as its matcher', () => {
    expect(storedMatcher({ ...none, garmentId: 7 })).toEqual({
      by: 'garment',
      garmentId: 7,
    });
    expect(
      storedMatcher({
        ...none,
        category: GarmentCategory.FOOTWEAR,
        type: null,
      }),
    ).toEqual({
      by: 'category',
      category: GarmentCategory.FOOTWEAR,
      type: null,
    });
    expect(
      storedMatcher({
        ...none,
        category: GarmentCategory.FOOTWEAR,
        type: 'sneakers',
      }),
    ).toEqual({
      by: 'category',
      category: GarmentCategory.FOOTWEAR,
      type: 'sneakers',
    });
    expect(storedMatcher({ ...none, color: 'red' })).toEqual({
      by: 'color',
      color: 'red',
    });
    expect(storedMatcher({ ...none, pattern: 'stripes' })).toEqual({
      by: 'pattern',
      pattern: 'stripes',
    });
  });

  it('refuses a side with no matcher, which the table checks forbid', () => {
    expect(() => storedMatcher(none)).toThrow('has no matcher');
  });
});
