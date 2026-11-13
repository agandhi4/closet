/**
 * The one rule for "is this the JSON API's address" (#190): `/api` itself
 * or anything under it, in any case (`/API/v1/me`), never `/apix`. Read by
 * surfaceOf (src/web/surface.ts: an unmatched request's surface) and
 * bypassesWorker (src/web/page-cache.ts: what the service worker leaves
 * alone), so the server and the worker can never disagree on a spelling.
 * A module of its own, free of Fastify, because the worker's bundle
 * imports it. Takes a path or a request URL (the query and fragment after
 * the path are allowed).
 */
const API_PATH = /^\/api(?:[/?#]|$)/i;

export function isApiPath(path: string): boolean {
  return API_PATH.test(path);
}
