/**
 * What the server and the service worker's page cache agree on
 * (views/assets/src-sw.ts bundles this file; keep it free of Node and DOM).
 *
 * The tab roots open stale-while-revalidate: the worker answers a document
 * load from its cache at once and fetches the page again behind it. The
 * page on screen learns how old it is and whether the server's copy differs
 * from the worker (public/js/freshness.js), and says so.
 */

import { LOGIN_PATH } from './auth/login-path';
import { type Section, SECTION_HOME } from './layout/sections';

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
 * Set by endSession (src/web/auth/session.ts) on every answer that ends a
 * session on this device: sign-out, account deletion, and a cookie that no
 * longer opens a session (revoked elsewhere, expired), whatever the answer
 * is, a 4xx included. The worker reads it as the session's end (#131).
 * Clear-Site-Data, sent beside it, cannot serve: Chromium applies it and
 * hides it from the response, the worker's own fetch included.
 */
export const SESSION_ENDED_HEADER = 'X-Session-Ended';

/** Whether the server ended this device's session with this answer. */
export function endedSession(headers: { has(name: string): boolean }): boolean {
  return headers.has(SESSION_ENDED_HEADER);
}

/** The MCP endpoint's path (src/web/mcp): an API for programs, never a page. */
export const MCP_PATH = '/mcp';

/** The wardrobe export's downloads (src/web/wardrobe/export-routes.ts, #200). */
export function wardrobeExportPath(format: 'csv' | 'json'): string {
  return `/wardrobe/export.${format}`;
}

const EXPORT_PATHS: ReadonlySet<string> = new Set([
  wardrobeExportPath('csv'),
  wardrobeExportPath('json'),
]);

/**
 * Requests no worker route matches, so the worker neither answers nor
 * caches them: the MCP endpoint, and the wardrobe export. Programs call
 * MCP, not the app (and they have no worker), but a browser tab opened on
 * it must reach the server as it is and never land in the page cache. An
 * export is a download the browser navigates to: as a page it would be
 * stored in the page cache (a whole wardrobe per copy) and answered from
 * there offline, stale.
 */
export function bypassesWorker(url: { pathname: string }): boolean {
  return (
    url.pathname === MCP_PATH ||
    url.pathname.startsWith(`${MCP_PATH}/`) ||
    EXPORT_PATHS.has(url.pathname)
  );
}

/**
 * The sections whose home opens stale-while-revalidate: every one but
 * Today. Styling's `/styling` (#42) qualifies: the bare page is the fresh
 * stack, a function of the wardrobe alone (freshStates: the newest garment
 * of each worn role, never the day's seed, the forecast, rotation or what
 * is clean), so it renders byte for byte the same until the wardrobe
 * changes; Shuffle's seed only appears once Shuffle answers. Its other
 * addresses (`?with=`, `?for=`, `?outfit=`, `?ownerId=`) carry a query and
 * go to the network like every navigation. Today (`/`, the manifest's start_url) is all of the day's own
 * data (the plan, the suggestions, what was worn, the weather through
 * them), so it could only be byte-stable by loading all of it as
 * fragments, leaving a shell with a date; and a copy opened first would
 * put yesterday's plan and "Wear this" on screen. It is NetworkFirst like
 * any page (the navigation preload races a cold worker), and offline the
 * worker's last copy shows with its age (freshness.js) and its writes
 * disabled. #15 decided it.
 */
const OPENS_STALE: readonly Section[] = [
  'wardrobe',
  'styling',
  'outfits',
  'calendar',
];

/**
 * The tab roots the worker opens from its cache. Exact paths without a
 * query: a filtered wardrobe or another calendar week is a place the user
 * navigated to, and goes to the network first like every other page.
 */
const TAB_ROOTS: ReadonlySet<string> = new Set(
  OPENS_STALE.map((section) => SECTION_HOME[section]),
);

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

/**
 * A page request the server redirected to the login page, which then
 * rendered for nobody (a followed redirect: htmx's boosted XHR, a
 * revalidation): nobody is signed in any more. The session gate is what
 * sends a page there, so it is how the worker learns of a session ended away
 * from this device (a password changed elsewhere, the account deleted, a
 * rotated secret, expiry), which no sign-out POST announced. The landing
 * page's account is what tells it apart from a redirect that keeps the
 * session: DISABLE_REGISTRATION sends a signed-in user from /auth/register to
 * the login page too, rendered for that user.
 */
export function sentToLogin(response: {
  redirected: boolean;
  url: string;
  headers: { get(name: string): string | null };
}): boolean {
  return (
    response.redirected &&
    new URL(response.url).pathname === LOGIN_PATH &&
    pageAccount(response.headers) === ''
  );
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
