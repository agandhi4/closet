import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  configurePhotoUrls,
  imageUrl,
  type PhotoUrlQuery,
  selfieUrl,
  type SignablePhotoRef,
  signedPhoto,
} from './image-url';
import { readPhotoRef } from './queries';

const NAME = '0b8f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4.webp';
const KEY = 'a1b2c3d4e5f6';

/** A URL's path and query as the /file route reads them. */
function parse(url: string): { path: string; query: PhotoUrlQuery } {
  const { pathname, searchParams } = new URL(url, 'http://closet.test');
  return {
    path: pathname,
    query: Object.fromEntries(searchParams),
  };
}

describe('imageUrl', () => {
  const keyed = readPhotoRef({ fileName: NAME, version: 3, variantKey: KEY });

  it('names the variant by path and the set by its query', () => {
    expect(parse(imageUrl(keyed, 'original')).path).toBe(`/file/${NAME}`);
    expect(parse(imageUrl(keyed, 'nobg')).path).toBe(`/file/nobg/${NAME}`);
    expect(parse(imageUrl(keyed, 'thumb')).path).toBe(`/file/thumb/${NAME}`);
    expect(imageUrl(keyed, 'thumb')).toMatch(
      new RegExp(`^/file/thumb/${NAME}\\?v=3&k=${KEY}&s=[A-Za-z0-9_-]{16}$`),
    );
  });

  // So a worker can stand one variant in for another by its path alone.
  it('gives a photo the same query on every variant', () => {
    const queries = (['original', 'nobg', 'thumb'] as const).map(
      (variant) => imageUrl(keyed, variant).split('?')[1],
    );
    expect(new Set(queries).size).toBe(1);
  });

  it('leaves the key out while the set is unkeyed, and defaults the version to 1', () => {
    expect(
      imageUrl(readPhotoRef({ fileName: NAME, variantKey: null }), 'thumb'),
    ).toMatch(new RegExp(`^/file/thumb/${NAME}\\?v=1&s=[A-Za-z0-9_-]{16}$`));
  });

  // Only the photo-ref helpers of queries.ts make a SignablePhotoRef: an
  // object with the right fields, a selfie's row say, is not one (#162).
  it('takes only a branded photo ref', () => {
    const plain = { fileName: NAME, version: 3, variantKey: null };
    // @ts-expect-error a plain object is not a SignablePhotoRef
    expect(imageUrl(plain, 'thumb')).toMatch(/^\/file\/thumb\//);
    expectTypeOf(plain).not.toExtend<SignablePhotoRef>();
    expectTypeOf(readPhotoRef(plain)).toExtend<SignablePhotoRef>();
  });

  it('percent-encodes the file name', () => {
    expect(
      imageUrl(
        readPhotoRef({ fileName: 'a b.webp', variantKey: null }),
        'original',
      ),
    ).toMatch(/^\/file\/a%20b\.webp\?v=1&s=/);
  });
});

describe('signedPhoto', () => {
  const photo = readPhotoRef({ fileName: NAME, version: 4, variantKey: KEY });

  it('answers the set a URL names when its signature holds', () => {
    const { query } = parse(imageUrl(photo, 'nobg'));
    expect(signedPhoto(NAME, query)).toEqual({
      fileName: NAME,
      variantKey: KEY,
    });
    const unkeyed = parse(imageUrl({ ...photo, variantKey: null }, 'thumb'));
    expect(signedPhoto(NAME, unkeyed.query)).toEqual({
      fileName: NAME,
      variantKey: null,
    });
  });

  it('refuses a URL whose name, key or version was changed', () => {
    const { query } = parse(imageUrl(photo, 'thumb'));
    const other = '1c9e2d3f-4e5b-4c6d-9e7f-8091a2b3c4d5.webp';
    expect(signedPhoto(other, query)).toBeUndefined();
    expect(signedPhoto(NAME, { ...query, k: 'ffffffffffff' })).toBeUndefined();
    expect(signedPhoto(NAME, { ...query, k: undefined })).toBeUndefined();
    // A page script that only rewrites `v` must not reach the old set.
    expect(signedPhoto(NAME, { ...query, v: '5' })).toBeUndefined();
  });

  it('refuses a URL without a well-formed signature', () => {
    const { query } = parse(imageUrl(photo, 'thumb'));
    expect(signedPhoto(NAME, { v: '4' })).toBeUndefined();
    expect(signedPhoto(NAME, { ...query, s: 'short' })).toBeUndefined();
    expect(signedPhoto(NAME, { ...query, v: 'x' })).toBeUndefined();
    expect(signedPhoto(NAME, { ...query, k: '../app.log' })).toBeUndefined();
  });

  it('refuses a URL signed under another secret', () => {
    configurePhotoUrls('the-first-secret-0123456789abcdef-0123');
    const { query } = parse(imageUrl(photo, 'thumb'));
    expect(signedPhoto(NAME, query)).toBeDefined();
    configurePhotoUrls('the-second-secret-0123456789abcdef-012');
    expect(signedPhoto(NAME, query)).toBeUndefined();
  });
});

describe('selfieUrl', () => {
  it('builds the owner-only path, unsigned', () => {
    expect(selfieUrl({ fileName: NAME, version: 2 }, 'thumb')).toBe(
      `/selfies/thumb/${NAME}?v=2`,
    );
    expect(selfieUrl({ fileName: NAME }, 'original')).toBe(
      `/selfies/${NAME}?v=1`,
    );
  });
});
