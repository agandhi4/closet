// The service worker's rules for keeping each build's static files (#656, src/web/shell/AGENTS.md,
// Service worker strategies). Below web/ because the static server (src/static-assets.ts) stamps
// what the worker reads. Bundled into the service worker (views/assets/src-sw.ts): keep it free
// of Node and DOM.

/**
 * On every static answer: the build (BuildInfo.assetVersion) whose bytes it carries. The server
 * ignores `?v=`, so a URL naming one build can be answered with another's bytes (a page of the
 * previous build asking after a deploy); the worker keeps an answer under its URL only when the
 * two agree (`answersItsBuild`). Set by src/static-assets.ts.
 */
export const ASSET_VERSION_HEADER = 'X-Asset-Version';

/** How many builds' files the worker keeps: the newest and the one before it, each whole. */
export const KEPT_BUILDS = 2;

/**
 * The build a first-party static URL names (`?v=`, src/web/layout/layout.tsx and the importmap),
 * or undefined for a URL the per-build cache does not hold: another origin, a path outside the
 * versioned roots, no `v`.
 */
export function assetBuildOf(url: URL, origin: string): string | undefined {
  if (url.origin !== origin) return undefined;
  const { pathname } = url;
  const versioned =
    pathname === '/bundle.css' ||
    pathname.startsWith('/js/') ||
    pathname.startsWith('/vendor/') ||
    pathname.startsWith('/modules/');
  if (!versioned) return undefined;
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
