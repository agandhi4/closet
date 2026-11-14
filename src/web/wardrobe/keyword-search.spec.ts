import { describe, expect, it } from 'vitest';
import { keywordTokens } from './keyword-search';

// The labels' side of the keyword (#673): which stored keys a word names.
// The SQL side, and that the two agree, is wardrobe-grid's and mcp-seed's.
describe('keywordTokens', () => {
  const keys = (keyword: string) =>
    keywordTokens(keyword).map(({ text, colors, types, categories }) => ({
      text,
      colors,
      types,
      categories,
    }));

  it('resolves a word to the keys whose label has a word it starts', () => {
    expect(keys('Blue  shirt')).toEqual([
      { text: 'blue', colors: ['blue'], types: [], categories: [] },
      // Not T-shirt or Sweatshirt: words split on whitespace only.
      { text: 'shirt', colors: [], types: ['shirt'], categories: [] },
    ]);
    expect(keys('coat')[0].types).toEqual(['coat', 'trench']);
    expect(keys('t-shirt')[0].types).toEqual(['t-shirt']);
    // A label that differs from its key: "Multicolor" is `pattern`.
    expect(keys('multicolour')[0].colors).toEqual([]);
    expect(keys('multi')[0].colors).toEqual(['pattern']);
    expect(keys('top')[0].categories).toEqual(['tops']);
  });

  it('folds punctuation, and keeps a punctuation-only word as itself', () => {
    expect(keywordTokens('J.Crew %')).toMatchObject([
      { text: 'jcrew', folded: true },
      { text: '%', folded: false, colors: [], types: [], categories: [] },
    ]);
    expect(keywordTokens('   ')).toEqual([]);
  });
});
