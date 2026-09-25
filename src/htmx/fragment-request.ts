/**
 * Tells a request that wants an HTML fragment apart from one that wants a full
 * page. Shared by the server (WardrobeController) and the service worker
 * (views/assets/src-sw.ts, bundled by esbuild), so both sides agree on which
 * responses are fragments: a cached fragment must never be served as a page
 * and vice versa.
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

/**
 * Runtime cache key for a page URL: fragments get a `|hx` suffix so they live
 * beside, never instead of, the full page for the same URL.
 */
export function pageCacheKey(url: string, headers: HeaderSource): string {
  return isFragmentRequest(headers) ? `${url}|hx` : url;
}

/** Response header telling caches that the body depends on these headers. */
export const FRAGMENT_VARY =
  'HX-Request, HX-Boosted, HX-History-Restore-Request';
