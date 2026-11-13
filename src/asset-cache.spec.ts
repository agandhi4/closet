import { describe, expect, it } from 'vitest';
import {
  answersItsBuild,
  ASSET_VERSION_HEADER,
  assetBuildOf,
  keptBuilds,
  unversionedUrl,
} from './asset-cache';

const ORIGIN = 'https://closet.test';
const at = (path: string) => new URL(`${ORIGIN}${path}`);

describe('assetBuildOf', () => {
  it.each([
    ['/js/pwa.js?v=abc1234', 'abc1234'],
    ['/bundle.css?v=abc1234', 'abc1234'],
    ['/vendor/styling.js?v=abc1234', 'abc1234'],
    ['/modules/htmx.min.js?v=abc1234', 'abc1234'],
  ])('%s names build %s', (path, build) => {
    expect(assetBuildOf(at(path), ORIGIN)).toBe(build);
  });

  it.each([
    // No build named: the precache answers it as it always did.
    '/js/pwa.js',
    '/js/pwa.js?v=',
    '/vendor/fonts/inter-latin-wght-normal.abc.woff2',
    // Not a versioned root: photos carry their own ?v, and are a session's.
    '/file/thumb/a.webp?v=3',
    '/favicon.ico?v=abc1234',
    '/bundle.css.map?v=abc1234',
  ])('%s is no build file', (path) => {
    expect(assetBuildOf(at(path), ORIGIN)).toBeUndefined();
  });

  it('is never another origin', () => {
    expect(
      assetBuildOf(new URL('https://cdn.test/js/pwa.js?v=abc'), ORIGIN),
    ).toBeUndefined();
  });
});

describe('unversionedUrl', () => {
  it('drops only the build', () => {
    expect(unversionedUrl(at('/js/pwa.js?v=abc&x=1'))).toBe(
      `${ORIGIN}/js/pwa.js?x=1`,
    );
    expect(unversionedUrl(at('/bundle.css?v=abc'))).toBe(
      `${ORIGIN}/bundle.css`,
    );
  });
});

describe('answersItsBuild', () => {
  const answer = (build?: string) =>
    new Headers(build ? { [ASSET_VERSION_HEADER]: build } : {});

  it('keeps an answer that is the build its URL names', () => {
    expect(answersItsBuild('b', answer('b'))).toBe(true);
  });

  it.each([
    // A page of build A asking after B was deployed: B's bytes, never under A.
    ['another build', answer('b'), 'a'],
    // A server from before the header: nothing says whose bytes they are.
    ['no header', answer(), 'a'],
  ])('refuses %s', (_case, headers, build) => {
    expect(answersItsBuild(build, headers)).toBe(false);
  });
});

describe('keptBuilds', () => {
  it('keeps the new build and the one before it, whole', () => {
    expect(keptBuilds([], 'a')).toEqual(['a']);
    expect(keptBuilds(['a'], 'b')).toEqual(['b', 'a']);
    expect(keptBuilds(['b', 'a'], 'c')).toEqual(['c', 'b']);
  });

  it('changes nothing for a build already newest', () => {
    expect(keptBuilds(['b', 'a'], 'b')).toEqual(['b', 'a']);
  });

  it('puts a rolled-back build first again', () => {
    expect(keptBuilds(['b', 'a'], 'a')).toEqual(['a', 'b']);
  });
});
