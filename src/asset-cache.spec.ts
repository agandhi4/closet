import { describe, expect, it } from 'vitest';
import {
  answersItsBuild,
  answerVersionedAsset,
  type AssetCache,
  ASSET_VERSION_HEADER,
  assetBuildOf,
  BuildAssets,
  buildFilePaths,
  CLIENT_MODULE_PATHS,
  isStorableAsset,
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

/** A Cache by exact URL, as `caches.open` gives the worker. */
function fakeCache(): AssetCache & { urls(): string[] } {
  const entries = new Map<string, Response>();
  return {
    match: (url) => Promise.resolve(entries.get(url)?.clone()),
    put: (url, response) => {
      entries.set(url, response);
      return Promise.resolve();
    },
    delete: (url) => Promise.resolve(entries.delete(url)),
    keys: () => Promise.resolve([...entries.keys()].map((url) => ({ url }))),
    urls: () => [...entries.keys()].filter((url) => url.startsWith(ORIGIN)),
  };
}

/** The server: answers any path as `build` (it ignores `?v=`), except those listed. */
function server(
  build: string,
  answers: Record<string, { status?: number; build?: string } | 'offline'> = {},
) {
  const asked: string[] = [];
  const fetchAsset = (url: string): Promise<Response> => {
    asked.push(url);
    const answer = answers[new URL(url).pathname] ?? {};
    if (answer === 'offline') {
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    return Promise.resolve(
      new Response(`${new URL(url).pathname} of ${build}`, {
        status: answer.status ?? 200,
        headers: { [ASSET_VERSION_HEADER]: answer.build ?? build },
      }),
    );
  };
  return { asked, fetchAsset };
}

const PATHS = ['/bundle.css', '/js/pwa.js', CLIENT_MODULE_PATHS.htmx];
const urlsOf = (build: string) =>
  PATHS.map((path) => `${ORIGIN}${path}?v=${build}`);

describe('isStorableAsset', () => {
  const response = (status: number, build: string) => ({
    status,
    headers: new Headers({ [ASSET_VERSION_HEADER]: build }),
  });

  it('keeps a 200 that is the build its URL names', () => {
    expect(
      isStorableAsset(at('/js/pwa.js?v=a'), ORIGIN, response(200, 'a')),
    ).toBe(true);
  });

  it.each([
    ['another build', '/js/pwa.js?v=a', response(200, 'b')],
    ['a failure', '/js/pwa.js?v=a', response(500, 'a')],
    ['an unversioned URL', '/js/pwa.js', response(200, 'a')],
  ])('refuses %s', (_case, path, answer) => {
    expect(isStorableAsset(at(path), ORIGIN, answer)).toBe(false);
  });
});

describe('buildFilePaths', () => {
  it('is the precache scripts and styles, the modules and the opt-in beacon, never the fonts', () => {
    const paths = buildFilePaths(
      [
        'bundle.css',
        'js/pwa.js',
        'vendor/styling.js',
        'vendor/fonts/inter.abc.woff2',
        'favicon.ico',
        'manifest.json',
      ],
      ORIGIN,
    );
    expect(paths).toEqual(
      [
        '/bundle.css',
        '/js/errors.js',
        '/js/pwa.js',
        '/vendor/styling.js',
        ...Object.values(CLIENT_MODULE_PATHS),
      ].sort(),
    );
  });
});

describe('answerVersionedAsset', () => {
  const sources = (stored?: string, precached?: string) => {
    const calls = { fetched: 0, behind: 0, precachedAs: '' };
    return {
      calls,
      sources: {
        stored: () =>
          Promise.resolve(stored ? new Response(stored) : undefined),
        precached: (unversioned: string) => {
          calls.precachedAs = unversioned;
          return Promise.resolve(
            precached ? new Response(precached) : undefined,
          );
        },
        fetchAndStore: () => {
          calls.fetched += 1;
          return Promise.resolve(new Response('network'));
        },
        behind: () => {
          calls.behind += 1;
        },
      },
    };
  };

  it('answers the exact URL from the build cache, asking nothing else', async () => {
    const { calls, sources: s } = sources('A bytes', 'B bytes');
    const answer = await answerVersionedAsset(at('/js/pwa.js?v=a'), s);
    expect(await answer.text()).toBe('A bytes');
    expect(calls).toEqual({ fetched: 0, behind: 0, precachedAs: '' });
  });

  it('serves the precache without a copy, fetching the build behind it', async () => {
    const { calls, sources: s } = sources(undefined, 'B bytes');
    const answer = await answerVersionedAsset(at('/js/pwa.js?v=b'), s);
    expect(await answer.text()).toBe('B bytes');
    expect(calls).toEqual({
      fetched: 1,
      behind: 1,
      precachedAs: `${ORIGIN}/js/pwa.js`,
    });
  });

  it('answers from the network what the precache lacks', async () => {
    const { sources: s } = sources();
    const answer = await answerVersionedAsset(
      at(`${CLIENT_MODULE_PATHS.htmx}?v=b`),
      s,
    );
    expect(await answer.text()).toBe('network');
  });
});

describe('BuildAssets', () => {
  const store = (cache = fakeCache()) => ({
    cache,
    assets: new BuildAssets(
      () => Promise.resolve(cache),
      ORIGIN,
      () => undefined,
    ),
  });

  it("keeps the install's whole set under the build's own URLs, complete", async () => {
    const { cache, assets } = store();
    const result = await assets.storeBuildSet(PATHS, server('a').fetchAsset);
    expect(result).toEqual({ build: 'a', stored: 3, missing: [] });
    expect(cache.urls().sort()).toEqual(urlsOf('a').sort());
    expect(await (await cache.match(`${ORIGIN}/js/pwa.js?v=a`))?.text()).toBe(
      '/js/pwa.js of a',
    );
    expect(await assets.isComplete('a')).toBe(true);
  });

  it("never keeps another build's answer under a URL, and the build stays incomplete", async () => {
    const { cache, assets } = store();
    // A deploy mid-install: the server answers one file as the next build.
    const result = await assets.storeBuildSet(
      PATHS,
      server('a', { '/js/pwa.js': { build: 'b' } }).fetchAsset,
    );
    expect(result.missing).toEqual(['/js/pwa.js']);
    expect(await cache.match(`${ORIGIN}/js/pwa.js?v=a`)).toBeUndefined();
    expect(await assets.isComplete('a')).toBe(false);
  });

  it.each([
    ['a failed fetch', 'offline' as const],
    ['a 404', { status: 404 }],
  ])('leaves the build incomplete on %s', async (_case, answer) => {
    const { assets } = store();
    const result = await assets.storeBuildSet(
      PATHS,
      server('a', { [CLIENT_MODULE_PATHS.htmx]: answer }).fetchAsset,
    );
    expect(result.missing).toEqual([CLIENT_MODULE_PATHS.htmx]);
    expect(await assets.isComplete('a')).toBe(false);
  });

  it('stores nothing when the server names no build', async () => {
    const { cache, assets } = store();
    const unnamed = () => Promise.resolve(new Response('old server'));
    const result = await assets.storeBuildSet(PATHS, unnamed);
    expect(result).toEqual({ build: undefined, stored: 0, missing: PATHS });
    expect(cache.urls()).toEqual([]);
  });

  it('keeps the current and previous builds, dropping older ones whole', async () => {
    const { cache, assets } = store();
    await assets.storeBuildSet(PATHS, server('a').fetchAsset);
    await assets.storeBuildSet(PATHS, server('b').fetchAsset);
    await assets.storeBuildSet(PATHS, server('c').fetchAsset);
    expect(cache.urls().sort()).toEqual(
      [...urlsOf('b'), ...urlsOf('c')].sort(),
    );
    expect(await assets.kept()).toEqual([
      { build: 'c', complete: true },
      { build: 'b', complete: true },
    ]);
    expect(await assets.isComplete('a')).toBe(false);
  });

  it("keeps a build's completeness when a page later stores one of its files", async () => {
    const { assets } = store();
    await assets.storeBuildSet(PATHS, server('a').fetchAsset);
    await assets.keep('b');
    await assets.keep('a');
    expect(await assets.kept()).toEqual([
      { build: 'a', complete: true },
      { build: 'b', complete: false },
    ]);
  });

  it('serves no older page that names no build', async () => {
    const { assets } = store();
    await assets.storeBuildSet(PATHS, server('a').fetchAsset);
    expect(await assets.isComplete(null)).toBe(false);
  });
});
