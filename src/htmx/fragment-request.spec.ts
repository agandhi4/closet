import { describe, expect, it } from 'vitest';
import {
  isFragmentRequest,
  pageCacheKey,
  pageUrlOfCacheKey,
} from './fragment-request';

describe('fragment-request', () => {
  const url = 'https://closet.example/wardrobe?keyword=blue';

  it('treats a plain htmx request as a fragment', () => {
    expect(isFragmentRequest({ 'hx-request': 'true' })).toBe(true);
    expect(pageCacheKey(url, { 'hx-request': 'true' })).toBe(`${url}|hx`);
  });

  it('treats navigations as full pages', () => {
    expect(isFragmentRequest({})).toBe(false);
    expect(pageCacheKey(url, {})).toBe(url);
  });

  it('treats boosted and history-restore requests as full pages', () => {
    expect(
      isFragmentRequest({ 'hx-request': 'true', 'hx-boosted': 'true' }),
    ).toBe(false);
    expect(
      isFragmentRequest({
        'hx-request': 'true',
        'hx-history-restore-request': 'true',
      }),
    ).toBe(false);
  });

  it('reads Fetch-style Headers the same way as Node header objects', () => {
    const fragment = new Headers({ 'HX-Request': 'true' });
    const boosted = new Headers({ 'HX-Request': 'true', 'HX-Boosted': 'true' });
    expect(pageCacheKey(url, fragment)).toBe(`${url}|hx`);
    expect(pageCacheKey(url, boosted)).toBe(url);
  });

  it('reads the page URL back from a stored key, the suffix encoded or not', () => {
    const fragment = new Headers({ 'HX-Request': 'true' });
    const key = pageCacheKey('https://closet.example/wardrobe/12', fragment);
    expect(pageUrlOfCacheKey(key)).toBe('https://closet.example/wardrobe/12');
    expect(pageUrlOfCacheKey(new Request(key).url)).toBe(
      'https://closet.example/wardrobe/12',
    );
    expect(pageUrlOfCacheKey(url)).toBe(url);
  });

  it('takes the first value of a repeated header', () => {
    expect(isFragmentRequest({ 'hx-request': ['true', 'false'] })).toBe(true);
  });
});
