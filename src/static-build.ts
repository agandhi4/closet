// The static set's identity and the service worker's per-build precaches (#656,
// src/web/shell/updates.md, Each build's static files). The id is a hash of the precache manifest,
// computed by the build (scripts/generate-sw.ts, into public/build.json, read by
// src/build-info.ts as the `?v=` key) and by the worker (views/assets/src-sw.ts, from its own
// injected manifest) with the one function, so a page's `?v=` names the precache holding exactly
// its bytes. Bundled into the worker: keep it free of Node and DOM globals; the worker hands in
// its CacheStorage, so static-build.spec.ts drives it with a stand-in.

/**
 * On every rendered page: the static build its `?v=` URLs name (BuildInfo.assetVersion, set by
 * src/web/render.ts). The worker serves an older build's stored page only while that build's
 * precache is installed here (`isInstalled`).
 */
export const ASSET_VERSION_HEADER = 'X-Asset-Version';

/** One precache manifest entry, as workbox-build writes it and the worker reads it. */
export type ManifestEntry = string | { url: string; revision?: string | null };

// cyrb53: a sync 53-bit string hash. The worker cannot await crypto.subtle while its script is
// evaluated, which is when the precache's name must be known.
function hash53(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * The content id of a static set: its files and their revisions, in any order. Two builds whose
 * public/ bytes are the same (a deploy that changed only server code) share it, so their pages
 * keep their `?v=` and the precache that holds them; any changed, added or removed file makes a
 * new one.
 */
export function staticBuildId(manifest: readonly ManifestEntry[]): string {
  const lines = manifest
    .map((entry) =>
      typeof entry === 'string'
        ? `${entry} `
        : `${entry.url} ${entry.revision ?? ''}`,
    )
    .sort();
  return hash53(lines.join('\n')).toString(36).padStart(11, '0');
}

const PRECACHE_PREFIX = 'closet-precache-';

/** The precache of one static build: written only by the install of a worker built with it. */
export function precacheName(build: string): string {
  return `${PRECACHE_PREFIX}${build}`;
}

function isPrecacheName(name: string): boolean {
  return name.startsWith(PRECACHE_PREFIX);
}

// Off-origin, like the page cache's records: no request ever matches them. Each is written once,
// into its own build's precache, by the one worker that owns it: never read-modify-written.
/** The install fetched and checked every manifest entry (installPrecache in the worker). */
export const INSTALLED_KEY = 'https://precache.invalid/installed-at';
/** The build's worker activated (when): the cleanup's way to find the build it replaced. */
export const ACTIVATED_KEY = 'https://precache.invalid/activated-at';

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
 * or undefined for a URL no build precache answers: another origin, a path outside the versioned
 * roots, no `v` (the content-hashed fonts, the worker's own precache route's).
 */
export function assetBuildOf(url: URL, origin: string): string | undefined {
  if (url.origin !== origin || !isVersionedPath(url.pathname)) return undefined;
  return url.searchParams.get('v') || undefined;
}

/** The CacheStorage members used here (`self.caches` in the worker). */
export interface PrecacheStorage {
  keys(): Promise<string[]>;
  match(
    request: string,
    options: { cacheName: string; ignoreSearch?: boolean },
  ): Promise<Response | undefined>;
  delete(cacheName: string): Promise<boolean>;
}

/**
 * Answers a versioned URL from the precache of the build it names, and only that one: never
 * another build's bytes under its URL. `ignoreSearch`: the precache keys a file by its revision
 * (`?__WB_REVISION__=`), one entry per path. Without that build's copy (no such precache, or a
 * file its install has not fetched yet) the network answers, stored nowhere: the precache's
 * install is the only writer of build bytes. Never opens a cache by name, which would create it.
 */
export async function answerVersionedAsset(
  url: URL,
  origin: string,
  caches: Pick<PrecacheStorage, 'match'>,
  network: () => Promise<Response>,
): Promise<Response> {
  const build = assetBuildOf(url, origin);
  if (build === undefined) return network();
  const copy = await caches.match(`${url.origin}${url.pathname}`, {
    cacheName: precacheName(build),
    ignoreSearch: true,
  });
  return copy ?? network();
}

/**
 * Whether `build`'s precache holds its whole set: its install got to the end (INSTALLED_KEY). A
 * page naming no build (stored before pages named theirs) never has one.
 */
export async function isInstalled(
  caches: Pick<PrecacheStorage, 'match'>,
  build: string | null,
): Promise<boolean> {
  if (!build) return false;
  const marker = await caches.match(INSTALLED_KEY, {
    cacheName: precacheName(build),
  });
  return marker !== undefined;
}

/** One build's precache as the activate cleanup sees it. */
export interface PrecacheState {
  name: string;
  /** When its worker activated; undefined for one whose worker never did. */
  activatedAt: number | undefined;
}

/**
 * Which precaches an activating worker keeps: its own and the one of the build it replaces (the
 * latest to have activated before it, whose pages the activation refresh is about to replace and
 * which are its offline answer until then). Every other is dropped whole: an older build's, and a
 * waiting worker's that never activated (two deploys before Reload: the active build is kept, the
 * skipped one goes).
 */
export function keptPrecaches(
  precaches: readonly PrecacheState[],
  own: string,
): { kept: string[]; dropped: string[] } {
  let replaced: PrecacheState | undefined;
  for (const state of precaches) {
    if (state.name === own || state.activatedAt === undefined) continue;
    if (!replaced || state.activatedAt > (replaced.activatedAt ?? 0)) {
      replaced = state;
    }
  }
  const kept = [own, ...(replaced ? [replaced.name] : [])];
  return {
    kept,
    dropped: precaches
      .map((state) => state.name)
      .filter((name) => !kept.includes(name)),
  };
}

/**
 * The activate step (views/assets/src-sw.ts): every build precache but `own` and the replaced
 * build's is deleted (keptPrecaches). Runs before `own` records its activation, so `own` is never
 * mistaken for the build it replaces.
 */
export async function dropOtherPrecaches(
  caches: PrecacheStorage,
  own: string,
): Promise<{ kept: string[]; dropped: string[] }> {
  const names = (await caches.keys()).filter(isPrecacheName);
  const states = await Promise.all(
    names.map(async (name) => {
      const marker = await caches.match(ACTIVATED_KEY, { cacheName: name });
      return {
        name,
        activatedAt: marker ? Number(await marker.text()) : undefined,
      };
    }),
  );
  const result = keptPrecaches(states, own);
  await Promise.all(result.dropped.map((name) => caches.delete(name)));
  return result;
}
