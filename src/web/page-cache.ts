/**
 * What the server and the service worker's page cache agree on
 * (views/assets/src-sw.ts bundles this file; keep it free of Node and DOM).
 *
 * The tab roots open stale-while-revalidate: the worker answers a document
 * load from its cache at once and fetches the page again behind it. The
 * page on screen learns how old it is and whether the server's copy differs
 * from the worker (public/js/freshness.js), and says so.
 */

/**
 * The account a rendered page belongs to: the signed-in user's id, absent on
 * a signed-out render. Set by send() in src/web/render.ts on every HTML
 * answer. The worker keeps its page cache to one account and drops it when a
 * page for another arrives: it cannot read the httpOnly session cookie, so a
 * response is the only way it learns who is signed in.
 */
export const PAGE_ACCOUNT_HEADER = 'X-Page-Account';

/**
 * Added by the worker to the copy it caches: when it received the page from
 * the server (epoch ms, the device's clock, the one the page compares it
 * with). Only a response served from the cache carries it; public/js/
 * freshness.js reads it from htmx's requests.
 */
export const CACHED_AT_HEADER = 'X-SW-Cached-At';

/**
 * The dock's tabs, where the installed app opens (the manifest's start_url is
 * /wardrobe). Exact paths without a query: a filtered wardrobe or another
 * calendar week is a place the user navigated to, and goes to the network
 * first like every other page.
 */
const TAB_ROOTS = new Set(['/wardrobe', '/outfits', '/calendar']);

/**
 * Whether the worker answers this request from its cache before asking the
 * server. Document loads only (opening the app, a reload, a typed URL): an
 * in-app tap is an htmx request that follows the user's own writes (an
 * archive lands on /wardrobe through HX-Location), and must show them, so it
 * stays network first.
 */
export function servesStaleWhileRevalidate(
  request: { mode: string; url: string },
  origin: string,
): boolean {
  if (request.mode !== 'navigate') return false;
  const url = new URL(request.url);
  return (
    url.origin === origin && url.search === '' && TAB_ROOTS.has(url.pathname)
  );
}

/** When a cached page was stored; 0 for a response without the stamp. */
export function cachedAt(headers: {
  get(name: string): string | null;
}): number {
  const value = Number(headers.get(CACHED_AT_HEADER));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** The account a response says it was rendered for; '' when signed out. */
export function pageAccount(headers: {
  get(name: string): string | null;
}): string {
  return headers.get(PAGE_ACCOUNT_HEADER) ?? '';
}

/**
 * What a revalidation found, compared with the copy on screen:
 *  - current: the server renders the same page;
 *  - updated: it renders a different one (someone changed something);
 *  - signed-out: the session is gone (the server redirects to the login
 *    page, or refuses);
 *  - account-changed: the server rendered it for another account, so the
 *    copy on screen is not this session's;
 *  - failed: no usable answer (offline, a timeout, a server error); the copy
 *    stays.
 */
export type Revalidation =
  | 'current'
  | 'updated'
  | 'signed-out'
  | 'account-changed'
  | 'failed';

export interface CachedPage {
  account: string;
  body: string;
}

export interface FreshPage {
  status: number;
  /** A redirect the worker saw (opaque for a navigation). */
  redirected: boolean;
  account: string;
  /** Read only for a 200. */
  body: string;
}

/** `fresh` is undefined when the request never got an answer. */
export function revalidationOutcome(
  cached: CachedPage,
  fresh: FreshPage | undefined,
): Revalidation {
  if (!fresh) return 'failed';
  // A tab root only redirects or refuses without a session.
  if (fresh.redirected || fresh.status === 401) return 'signed-out';
  if (fresh.status !== 200) return 'failed';
  if (fresh.account !== cached.account) {
    return fresh.account === '' ? 'signed-out' : 'account-changed';
  }
  return fresh.body === cached.body ? 'current' : 'updated';
}
