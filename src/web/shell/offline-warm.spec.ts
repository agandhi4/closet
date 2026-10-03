import { describe, expect, it } from 'vitest';
import { isWarmedDetailPage, parseWarmList } from './offline-warm';

const ORIGIN = 'https://closet.test';

describe('parseWarmList', () => {
  const valid = {
    pages: ['/calendar?week=2026-10-04', '/wardrobe/12'],
    fragments: ['/wardrobe/tiles?before=40'],
    images: ['/file/thumb/a.webp?v=1&s=x'],
    keep: [],
  };

  it('takes a list of root-relative paths', () => {
    expect(parseWarmList(valid)).toEqual(valid);
  });

  it('drops a tab root: those are cached only when opened', () => {
    expect(
      parseWarmList({
        ...valid,
        pages: [
          '/wardrobe',
          '/styling',
          '/outfits',
          '/calendar',
          ...valid.pages,
        ],
      }),
    ).toEqual(valid);
  });

  it.each([
    ['not an object', 'pages'],
    ['null', null],
    ['a missing list', { ...valid, keep: undefined }],
    ['a list that is not an array', { ...valid, images: '/file/thumb/a' }],
    ['a path of another origin', { ...valid, pages: ['https://evil.test/'] }],
    ['a protocol-relative path', { ...valid, images: ['//evil.test/a.webp'] }],
    ['a relative path', { ...valid, fragments: ['wardrobe/tiles'] }],
    ['a value that is not a string', { ...valid, pages: [12] }],
  ])('refuses %s', (_name, value) => {
    expect(parseWarmList(value)).toBeUndefined();
  });
});

describe('isWarmedDetailPage', () => {
  it.each(['/wardrobe/12', '/outfits/3'])('owns %s', (path) => {
    expect(isWarmedDetailPage(new URL(`${ORIGIN}${path}`))).toBe(true);
  });

  it.each([
    // A shared wardrobe's garment: never the warm's to remove.
    '/wardrobe/12?ownerId=4',
    '/wardrobe',
    '/wardrobe/12/edit',
    '/wardrobe/tiles?before=40',
    '/outfits/ideas',
    '/wardrobe/12|hx',
  ])('leaves %s alone', (path) => {
    expect(isWarmedDetailPage(new URL(`${ORIGIN}${path}`))).toBe(false);
  });
});
