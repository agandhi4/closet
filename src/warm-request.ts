// What marks a request as the service worker's warm (#286, src/web/shell/offline-warm.md), below
// web/ so the request histogram can skip warms without importing a web module. Bundled into the
// service worker (views/assets/src-sw.ts): keep it free of Node and DOM.

/**
 * On every request a warm makes (the list, each page, each thumb), so the server's request log
 * tells warming apart from a person. Used by views/assets/src-sw.ts and
 * isWarmRequest below.
 */
export const WARM_REQUEST_HEADER = 'X-Closet-Warm';

/**
 * Whether a request is a warm's, from Node's lower-cased headers. Used by src/app.ts (the request
 * log marks it) and src/metrics/http.ts (the request histogram leaves it out).
 */
export function isWarmRequest(
  headers: Record<string, string | string[] | undefined>,
): boolean {
  return headers[WARM_REQUEST_HEADER.toLowerCase()] !== undefined;
}
