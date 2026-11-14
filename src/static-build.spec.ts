import { describe, expect, it } from 'vitest';
import {
  ACTIVATED_KEY,
  answerContentHashed,
  answerVersionedAsset,
  assetBuildOf,
  dropOtherPrecaches,
  INSTALLED_KEY,
  isContentHashed,
  isInstalled,
  keptPrecaches,
  meetsItsBuild,
  type ManifestEntry,
  precacheName,
  type PrecacheStorage,
  staticBuildId,
  unversionedPrecacheVariants,
} from './static-build';

const ORIGIN = 'https://closet.test';
const at = (path: string) => new URL(`${ORIGIN}${path}`);

/** CacheStorage over plain maps: match by URL, `ignoreSearch` as the platform does it. */
class FakeCaches implements PrecacheStorage {
  readonly stores = new Map<string, Map<string, string>>();

  put(cacheName: string, url: string, body: string): void {
    const store = this.stores.get(cacheName) ?? new Map<string, string>();
    store.set(url, body);
    this.stores.set(cacheName, store);
  }

  keys(): Promise<string[]> {
    return Promise.resolve([...this.stores.keys()]);
  }

  match(
    request: string,
    options: { cacheName: string; ignoreSearch?: boolean },
  ): Promise<Response | undefined> {
    const store = this.stores.get(options.cacheName);
    const strip = (url: string) =>
      options.ignoreSearch ? url.split('?')[0] : url;
    const hit = [...(store?.entries() ?? [])].find(
      ([url]) => strip(url) === strip(request),
    );
    return Promise.resolve(hit ? new Response(hit[1]) : undefined);
  }

  delete(cacheName: string): Promise<boolean> {
    return Promise.resolve(this.stores.delete(cacheName));
  }
}

const network = () => Promise.resolve(new Response('network'));

describe('staticBuildId', () => {
  const manifest = [
    { url: 'bundle.css', revision: 'aaa' },
    { url: 'js/pwa.js', revision: 'bbb' },
    { url: 'modules/htmx.min.js', revision: 'ccc' },
  ];

  // The build step (scripts/generate-sw.ts) hands it workbox-build's entries,
  // which carry their size; the worker its injected manifest, in whatever
  // order: one id, or a page's ?v= names no precache.
  it('is the same for the build step and the worker', () => {
    const asBuilt = [...manifest].reverse().map((entry) => ({
      ...entry,
      size: 10,
    }));
    expect(staticBuildId(asBuilt)).toBe(staticBuildId(manifest));
    expect(staticBuildId(manifest)).toMatch(/^[0-9a-z]{11}$/);
  });

  it('changes with any file, added or removed', () => {
    const id = staticBuildId(manifest);
    expect(
      staticBuildId([
        ...manifest.slice(0, 2),
        { url: 'modules/htmx.min.js', revision: 'ddd' },
      ]),
    ).not.toBe(id);
    expect(staticBuildId(manifest.slice(1))).not.toBe(id);
    const withString: ManifestEntry[] = [...manifest, 'js/errors.js'];
    expect(staticBuildId(withString)).not.toBe(id);
  });
});

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
    // No build named: the precache route or answerContentHashed answers it.
    '/js/pwa.js',
    '/js/pwa.js?v=',
    '/vendor/fonts/inter-latin-wght-normal.abc.woff2',
    // Not a versioned root: photos carry their own ?v, and are a session's.
    '/file/thumb/a.webp?v=3',
    '/favicon.ico?v=abc1234',
  ])('%s names no build', (path) => {
    expect(assetBuildOf(at(path), ORIGIN)).toBeUndefined();
  });

  it('is never another origin', () => {
    expect(
      assetBuildOf(new URL('https://cdn.test/js/pwa.js?v=abc'), ORIGIN),
    ).toBeUndefined();
  });
});

describe('answerVersionedAsset', () => {
  const caches = new FakeCaches();
  caches.put(precacheName('A'), `${ORIGIN}/js/pwa.js?__WB_REVISION__=1`, 'A');
  caches.put(precacheName('B'), `${ORIGIN}/js/pwa.js?__WB_REVISION__=2`, 'B');

  it("answers from the named build's precache only", async () => {
    for (const build of ['A', 'B']) {
      const answer = await answerVersionedAsset(
        at(`/js/pwa.js?v=${build}`),
        ORIGIN,
        caches,
        network,
      );
      expect(await answer.text()).toBe(build);
    }
  });

  // The precache before 2026-11-13 answered any ?v with this build's bytes.
  it('asks the network for a build it has no precache of, storing nothing', async () => {
    const answer = await answerVersionedAsset(
      at('/js/pwa.js?v=C'),
      ORIGIN,
      caches,
      network,
    );
    expect(await answer.text()).toBe('network');
    expect(caches.stores.has(precacheName('C'))).toBe(false);
  });

  it("asks the network for a file the build's precache lacks", async () => {
    const answer = await answerVersionedAsset(
      at('/js/toast.js?v=A'),
      ORIGIN,
      caches,
      network,
    );
    expect(await answer.text()).toBe('network');
  });
});

describe('unversionedPrecacheVariants', () => {
  // #781: the layout names the favicon with ?v=; the precache keys it by its path.
  it('drops `v` from a file outside the versioned roots', () => {
    expect(
      unversionedPrecacheVariants(at('/favicon.ico?v=abc'), ORIGIN).map(
        (url) => url.href,
      ),
    ).toEqual([`${ORIGIN}/favicon.ico`]);
  });

  // The #742 invariant: a versioned root's ?v=X is X's bytes or the network.
  it.each(['/js/pwa.js?v=abc', '/js/pwa.js?v=', '/bundle.css?v=abc'])(
    "never offers %s as this build's file",
    (path) => {
      expect(unversionedPrecacheVariants(at(path), ORIGIN)).toEqual([]);
    },
  );

  it('adds nothing without `v` or for another origin', () => {
    expect(unversionedPrecacheVariants(at('/favicon.ico'), ORIGIN)).toEqual([]);
    expect(
      unversionedPrecacheVariants(
        new URL('https://cdn.test/favicon.ico?v=abc'),
        ORIGIN,
      ),
    ).toEqual([]);
  });
});

describe('answerContentHashed', () => {
  const font = '/vendor/fonts/inter-latin-wght-normal-abc.woff2';

  it('is only the bare fonts', () => {
    expect(isContentHashed(at(font), ORIGIN)).toBe(true);
    expect(isContentHashed(at(`${font}?v=A`), ORIGIN)).toBe(false);
    expect(isContentHashed(at('/vendor/styling.js'), ORIGIN)).toBe(false);
  });

  // #780: an older build's bundle.css names a font this build no longer has.
  it("answers from this build's precache, else the replaced build's", async () => {
    const caches = new FakeCaches();
    caches.put(precacheName('A'), ACTIVATED_KEY, '100');
    caches.put(precacheName('A'), `${ORIGIN}${font}?__WB_REVISION__=1`, 'A');
    caches.put(precacheName('B'), ACTIVATED_KEY, '200');
    caches.put(precacheName('B'), `${ORIGIN}/vendor/fonts/new.woff2`, 'B');
    const answer = (path: string) =>
      answerContentHashed(at(path), caches, precacheName('B'), network);

    expect(await (await answer(font)).text()).toBe('A');
    expect(await (await answer('/vendor/fonts/new.woff2')).text()).toBe('B');
    expect(await (await answer('/vendor/fonts/gone.woff2')).text()).toBe(
      'network',
    );
  });

  it('prefers the latest to have activated among the others', async () => {
    const caches = new FakeCaches();
    caches.put(precacheName('A'), ACTIVATED_KEY, '100');
    caches.put(precacheName('A'), `${ORIGIN}${font}`, 'A');
    caches.put(precacheName('B'), ACTIVATED_KEY, '200');
    caches.put(precacheName('B'), `${ORIGIN}${font}`, 'B');
    caches.put(precacheName('C'), `${ORIGIN}/js/pwa.js`, 'C');
    const copy = await answerContentHashed(
      at(font),
      caches,
      precacheName('C'),
      network,
    );
    expect(await copy.text()).toBe('B');
  });
});

describe('isInstalled', () => {
  it('needs the install to have reached its end', async () => {
    const caches = new FakeCaches();
    caches.put(precacheName('A'), `${ORIGIN}/js/pwa.js`, 'A');
    expect(await isInstalled(caches, 'A')).toBe(false);
    caches.put(precacheName('A'), INSTALLED_KEY, '1');
    expect(await isInstalled(caches, 'A')).toBe(true);
    expect(await isInstalled(caches, 'B')).toBe(false);
    expect(await isInstalled(caches, null)).toBe(false);
  });
});

describe('meetsItsBuild', () => {
  const caches = new FakeCaches();
  caches.put(precacheName('A'), INSTALLED_KEY, '1');
  caches.put(precacheName('C'), `${ORIGIN}/js/pwa.js`, 'C');

  it("serves this worker's own build's copies", async () => {
    expect(await meetsItsBuild(caches, 'B', 'B')).toBe(true);
  });

  it("serves another build's copy only while its precache is installed", async () => {
    expect(await meetsItsBuild(caches, 'A', 'B')).toBe(true);
    // Stored by this worker after the server deployed C, whose worker is
    // still installing: its ?v=C URLs would find no precache offline.
    expect(await meetsItsBuild(caches, 'C', 'B')).toBe(false);
    expect(await meetsItsBuild(caches, 'D', 'B')).toBe(false);
  });

  it('never serves a copy naming no build', async () => {
    expect(await meetsItsBuild(caches, null, 'B')).toBe(false);
  });
});

describe('keptPrecaches', () => {
  it('keeps its own and the latest to have activated before it', () => {
    expect(
      keptPrecaches(
        [
          { name: 'A', activatedAt: 1 },
          { name: 'B', activatedAt: 2 },
          { name: 'C', activatedAt: undefined },
        ],
        'C',
      ),
    ).toEqual({ kept: ['C', 'B'], dropped: ['A'] });
  });

  // The two-quick-merges case: A active, B waiting, C installs over B and is
  // the one Reload activates. A's pages are what the phone holds offline.
  it('keeps the active build over one skipped while it waited', () => {
    expect(
      keptPrecaches(
        [
          { name: 'A', activatedAt: 1 },
          { name: 'B', activatedAt: undefined },
          { name: 'C', activatedAt: undefined },
        ],
        'C',
      ),
    ).toEqual({ kept: ['C', 'A'], dropped: ['B'] });
  });

  // A rollback or a worker-only deploy: the same static set as before.
  it('never counts its own earlier activation as the replaced build', () => {
    expect(
      keptPrecaches(
        [
          { name: 'A', activatedAt: 1 },
          { name: 'B', activatedAt: 3 },
        ],
        'B',
      ),
    ).toEqual({ kept: ['B', 'A'], dropped: [] });
  });

  it('keeps only its own on a first install', () => {
    expect(keptPrecaches([{ name: 'A', activatedAt: undefined }], 'A')).toEqual(
      { kept: ['A'], dropped: [] },
    );
  });
});

describe('dropOtherPrecaches', () => {
  it('deletes every build precache but the kept ones, and nothing else', async () => {
    const caches = new FakeCaches();
    caches.put(precacheName('A'), ACTIVATED_KEY, '1');
    caches.put(precacheName('B'), INSTALLED_KEY, '2');
    caches.put(precacheName('C'), INSTALLED_KEY, '3');
    caches.put('pages-v2', `${ORIGIN}/wardrobe`, 'page');

    const result = await dropOtherPrecaches(caches, precacheName('C'));

    expect(result).toEqual({
      kept: [precacheName('C'), precacheName('A')],
      dropped: [precacheName('B')],
    });
    expect([...caches.stores.keys()].sort()).toEqual(
      [precacheName('A'), precacheName('C'), 'pages-v2'].sort(),
    );
  });
});
