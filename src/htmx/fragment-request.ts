/**
 * Tells a request that wants an HTML fragment apart from one that wants a full
 * page. Shared by the server (wantsFragment, src/web/render.ts) and the
 * service worker (views/assets/src-sw.ts, bundled by esbuild), so both sides
 * agree on which responses are fragments: a cached fragment must never be
 * served as a page and vice versa.
 *
 * htmx sends `HX-Request: true` on every request it makes, but only some of
 * those can take a fragment:
 *  - `HX-Boosted: true` (hx-boost links/forms) swaps the whole body, so it
 *    needs the full page;
 *  - `HX-History-Restore-Request: true` repopulates a page from history and
 *    needs the full page too.
 */

export interface HeaderReader {
  get(name: string): string | null | undefined;
}

/** Node's lower-cased IncomingHttpHeaders or the Fetch `Headers` class. */
export type HeaderSource =
  | HeaderReader
  | Record<string, string | string[] | undefined>;

function header(source: HeaderSource, name: string): string | undefined {
  if (typeof (source as HeaderReader).get === 'function') {
    return (source as HeaderReader).get(name) ?? undefined;
  }
  const value = (source as Record<string, string | string[] | undefined>)[
    name.toLowerCase()
  ];
  return Array.isArray(value) ? value[0] : value;
}

export function isFragmentRequest(headers: HeaderSource): boolean {
  return (
    header(headers, 'hx-request') === 'true' &&
    header(headers, 'hx-boosted') !== 'true' &&
    header(headers, 'hx-history-restore-request') !== 'true'
  );
}

const FRAGMENT_KEY_SUFFIX = '|hx';

/**
 * Runtime cache key for a page URL: fragments get a `|hx` suffix so they live
 * beside, never instead of, the full page for the same URL.
 */
export function pageCacheKey(url: string, headers: HeaderSource): string {
  return isFragmentRequest(headers) ? `${url}${FRAGMENT_KEY_SUFFIX}` : url;
}

// The suffix as Cache Storage hands a key back: a Request's URL, where a
// `|` in the path may come back percent-encoded.
const STORED_FRAGMENT_SUFFIX = /(?:\||%7C)hx$/i;

/**
 * The page URL a cache key (pageCacheKey, read back from `cache.keys()`) was
 * made for, without the fragment suffix: `/wardrobe/12|hx` is a fragment of
 * `/wardrobe/12`.
 */
export function pageUrlOfCacheKey(key: string): string {
  return key.replace(STORED_FRAGMENT_SUFFIX, '');
}

/** Response header telling caches that the body depends on these headers. */
export const FRAGMENT_VARY =
  'HX-Request, HX-Boosted, HX-History-Restore-Request';
