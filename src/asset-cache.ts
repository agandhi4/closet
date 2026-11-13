// The service worker's rules for keeping each build's static files (#656, src/web/shell/updates.md,
// Each build's static files). Below web/ because the static server (src/static-assets.ts) and the
// layout (src/web/layout/layout.tsx) stamp and name what the worker reads. Bundled into the
// service worker (views/assets/src-sw.ts): keep it free of Node and DOM globals; the worker hands
// in its caches and fetch (BuildAssets), so asset-cache.spec.ts drives it with stand-ins.

/**
 * On every static answer and every rendered page: the build (BuildInfo.assetVersion) whose bytes
 * it carries. The server ignores `?v=`, so a URL naming one build can be answered with another's
 * bytes (a page of the previous build asking after a deploy); the worker keeps an answer under its
 * URL only when the two agree (`answersItsBuild`), and serves an older build's stored page only
 * while that build's files are all kept (`BuildAssets.isComplete`). Set by src/static-assets.ts
 * and src/web/render.ts.
 */
export const ASSET_VERSION_HEADER = 'X-Asset-Version';

/** How many builds' files the worker keeps: the newest and the one before it, each whole. */
export const KEPT_BUILDS = 2;

/**
 * The client libraries the pages load from /modules/ (the layout's htmx tag and its importmap).
 * Never precached (workbox-config.js), so the worker's install fetches them by this list: a
 * module a page names and the list lacks is the one an older page would meet another build's
 * bytes for. Copied there by scripts/static-assets.ts (CLIENT_MODULES).
 */
export const CLIENT_MODULE_PATHS = {
  htmx: '/modules/htmx.min.js',
  workboxWindow: '/modules/workbox-window.prod.mjs',
  pwaInstall: '/modules/pwa-install.bundle.js',
  pullToRefresh: '/modules/pulltorefresh/index.esm.js',
} as const;

/**
 * Versioned files outside the precache besides the modules: the error beacon, loaded only with
 * SENTRY_DSN (the layout) and so not precached, but a page of a build that has one names it.
 */
const UNPRECACHED_SCRIPTS = ['/js/errors.js'];

function isVersionedPath(pathname: string): boolean {
  return (
    pathname === '/bundle.css' ||
    pathname.startsWith('/js/') ||
    pathname.startsWith('/vendor/') ||
    pathname.startsWith('/modules/')
  );
}

/**
 * The build a first-party static URL names (`?v=`, src/web/layout/layout.tsx and the importmap),
 * or undefined for a URL the per-build cache does not hold: another origin, a path outside the
 * versioned roots, no `v`.
 */
export function assetBuildOf(url: URL, origin: string): string | undefined {
  if (url.origin !== origin || !isVersionedPath(url.pathname)) return undefined;
  return url.searchParams.get('v') || undefined;
}

/** The URL without its `v`: how the precache knows the file (its manifest has no query). */
export function unversionedUrl(url: URL): string {
  const plain = new URL(url.href);
  plain.searchParams.delete('v');
  return plain.href;
}

/**
 * Whether a network answer may be kept under the URL that asked for `build`: only when the server
 * says it is that build's bytes. Anything else (another build, no header: an older server) is
 * served but never kept, or a page of one build would later load another's script under its own
 * URL.
 */
export function answersItsBuild(
  build: string,
  headers: { get(name: string): string | null },
): boolean {
  return headers.get(ASSET_VERSION_HEADER) === build;
}

/** A network answer to a versioned URL that may be kept under it: a 200 that is its build. */
export function isStorableAsset(
  url: URL,
  origin: string,
  response: { status: number; headers: { get(name: string): string | null } },
): boolean {
  const build = assetBuildOf(url, origin);
  return (
    build !== undefined &&
    response.status === 200 &&
    answersItsBuild(build, response.headers)
  );
}

/**
 * The builds kept once `stored` has a file in the cache, newest first: `stored` leads (a build is
 * only ever stored while the server runs it, so the latest stored is the newest deployed; a
 * rollback moves the older build back to the front), then the newest of the rest, up to
 * KEPT_BUILDS. Every other build is dropped whole: half of one build's files beside another's is
 * the mix the cache exists to prevent.
 */
export function keptBuilds(
  previous: readonly string[],
  stored: string,
): string[] {
  return [stored, ...previous.filter((build) => build !== stored)].slice(
    0,
    KEPT_BUILDS,
  );
}

/**
 * Every path a page of this worker's build can name with `?v=`: the precache manifest's scripts
 * and styles under the versioned roots (not the fonts: content-hashed names, the precache's
 * either way), the modules and the unprecached scripts. `manifest` is the precache's URLs, as
 * workbox-config.js writes them (relative to the origin).
 */
export function buildFilePaths(
  manifest: readonly string[],
  origin: string,
): string[] {
  const precached = manifest
    .map((url) => new URL(url, origin).pathname)
    .filter((path) => isVersionedPath(path) && /\.(m?js|css)$/.test(path));
  return [
    ...new Set([
      ...precached,
      ...Object.values(CLIENT_MODULE_PATHS),
      ...UNPRECACHED_SCRIPTS,
    ]),
  ].sort();
}

/**
 * Answers a versioned URL: its exact copy, else the precache's bytes (served, never kept under
 * the URL: the precache holds only the active build's) with the network's fetched and kept
 * behind it, else the network. Offline the fetch behind fails: the precache's copy is the answer
 * either way. The worker's BuildAsset strategy hands in its StrategyHandler's methods.
 */
export async function answerVersionedAsset(
  url: URL,
  sources: {
    stored(): Promise<Response | undefined>;
    precached(unversioned: string): Promise<Response | undefined>;
    fetchAndStore(): Promise<Response>;
    behind(work: Promise<unknown>): void;
  },
): Promise<Response> {
  const stored = await sources.stored();
  if (stored) return stored;
  const fetched = sources.fetchAndStore();
  const precached = await sources.precached(unversionedUrl(url));
  if (!precached) return fetched;
  sources.behind(fetched.catch(() => undefined));
  return precached;
}

/** The Cache members used here (`caches.open(...)` in the worker). */
export interface AssetCache {
  match(url: string): Promise<Response | undefined>;
  put(url: string, response: Response): Promise<void>;
  delete(url: string): Promise<boolean>;
  keys(): Promise<readonly { readonly url: string }[]>;
}

/** One kept build: complete once its install stored every file it names (storeBuildSet). */
export interface KeptBuild {
  build: string;
  complete: boolean;
}

/** What an install stored (storeBuildSet), for its log line. */
export interface BuildSetResult {
  /** The build the server answered with; undefined when it named none. */
  build: string | undefined;
  stored: number;
  /** Paths not stored: a failed fetch, a non-200, another build's bytes. */
  missing: string[];
}

// Off-origin, like the page cache's records: no request can ever match it.
const BUILDS_KEY = 'https://asset-cache.invalid/builds';

/**
 * The per-build static cache (`assets-v2`): the files, keyed by their exact `?v=` URL, and a
 * record of the builds kept, newest first, each marked complete or not. Every read-modify-write
 * of the record and every eviction runs one at a time.
 */
export class BuildAssets {
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly open: () => Promise<AssetCache>,
    private readonly origin: string,
    private readonly log: (message: string) => void,
  ) {}

  #serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async kept(): Promise<KeptBuild[]> {
    const record = await (await this.open()).match(BUILDS_KEY);
    return record ? (JSON.parse(await record.text()) as KeptBuild[]) : [];
  }

  /**
   * Whether an older build's stored page may be served: every file it can name is kept. A page
   * naming no build (stored before pages carried ASSET_VERSION_HEADER) never is.
   */
  async isComplete(build: string | null): Promise<boolean> {
    if (!build) return false;
    return (await this.kept()).some(
      (kept) => kept.build === build && kept.complete,
    );
  }

  /** `build` just had a file stored: it leads, and builds past the kept ones go whole. */
  keep(build: string): Promise<void> {
    return this.#serialized(() => this.#keep(build, false));
  }

  /**
   * The install's step (views/assets/src-sw.ts): every file of the build the server runs, fetched
   * and kept under its `?v=` URL. The build is the one the first answer names; each file is then
   * asked for under it and kept only when the server says it is that build (answersItsBuild). The
   * build is marked complete only when every path was kept, so a deploy mid-install, a failed
   * fetch or an older server leaves it incomplete: its pages are then never served from an older
   * copy (isComplete). Never throws for an answer; a caller logs the result.
   */
  async storeBuildSet(
    paths: readonly string[],
    fetchAsset: (url: string) => Promise<Response>,
  ): Promise<BuildSetResult> {
    const [first] = paths;
    if (first === undefined)
      return { build: undefined, stored: 0, missing: [] };
    const probe = await fetchAsset(`${this.origin}${first}`).catch(
      () => undefined,
    );
    const build = probe?.headers.get(ASSET_VERSION_HEADER) ?? undefined;
    if (!build) return { build, stored: 0, missing: [...paths] };
    const answers = await Promise.all(
      paths.map(async (path) => {
        const url = `${this.origin}${path}?v=${encodeURIComponent(build)}`;
        const response = await fetchAsset(url).catch(() => undefined);
        const storable =
          response !== undefined &&
          isStorableAsset(new URL(url), this.origin, response);
        return { path, url, response: storable ? response : undefined };
      }),
    );
    const missing = answers
      .filter((answer) => answer.response === undefined)
      .map((answer) => answer.path);
    await this.#serialized(async () => {
      const cache = await this.open();
      for (const { url, response } of answers) {
        if (response) await cache.put(url, response);
      }
      await this.#keep(build, missing.length === 0);
    });
    return { build, stored: answers.length - missing.length, missing };
  }

  async #keep(build: string, complete: boolean): Promise<void> {
    const previous = await this.kept();
    const builds = keptBuilds(
      previous.map((kept) => kept.build),
      build,
    );
    const next = builds.map((name) => ({
      build: name,
      complete:
        (name === build && complete) ||
        previous.some((kept) => kept.build === name && kept.complete),
    }));
    if (JSON.stringify(next) === JSON.stringify(previous)) return;
    const cache = await this.open();
    await cache.put(BUILDS_KEY, new Response(JSON.stringify(next)));
    const dropped = (await cache.keys()).filter((key) => {
      const keyBuild = assetBuildOf(new URL(key.url), this.origin);
      return keyBuild !== undefined && !builds.includes(keyBuild);
    });
    await Promise.all(dropped.map((key) => cache.delete(key.url)));
    this.log(
      `static files: keeping ${next
        .map((kept) => `${kept.build}${kept.complete ? '' : ' (incomplete)'}`)
        .join(', ')}, ${dropped.length} older file(s) dropped`,
    );
  }
}
