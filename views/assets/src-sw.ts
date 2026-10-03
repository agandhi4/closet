import { clientsClaim, copyResponse } from 'workbox-core';
import type {
  RouteHandlerCallbackOptions,
  WorkboxPlugin,
} from 'workbox-core/types';
import * as navigationPreload from 'workbox-navigation-preload';
import { precacheAndRoute } from 'workbox-precaching';
import { warmStrategyCache } from 'workbox-recipes';
import { registerRoute, setCatchHandler } from 'workbox-routing';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { ExpirationPlugin } from 'workbox-expiration';
import {
  CacheFirst,
  NetworkFirst,
  StaleWhileRevalidate,
  Strategy,
  StrategyHandler,
} from 'workbox-strategies';
import {
  pageCacheKey,
  pageUrlOfCacheKey,
} from '../../src/htmx/fragment-request';
import {
  bypassesWorker,
  CACHED_AT_HEADER,
  CACHED_AT_TIMING_NAME,
  cachedAt,
  endedSession,
  type FreshPage,
  isRenderedPage,
  pageAccount,
  type Revalidation,
  revalidationOutcome,
  sentToLogin,
  servesStaleWhileRevalidate,
} from '../../src/web/page-cache';
import {
  isWarmedDetailPage,
  parseWarmList,
  WARM_LIST_PATH,
  WARM_IMAGE_CAP,
  WARM_MAX_AGE_MS,
  WARM_PAGE_CAP,
  WARM_REQUEST_HEADER,
  WARM_USAGE_BUDGET_BYTES,
  type WarmList,
} from '../../src/web/shell/offline-warm';
import { openNotification } from '../../src/web/push/notification-click';
import { parsePushPayload, type PushPayload } from '../../src/web/push/payload';

/**
 * Caching model (public/js/pwa.js and public/js/freshness.js are the page
 * side):
 *  - App shell files under public/ are precached by content hash
 *    (workbox-config.js), so a repeat visit paints from cache.
 *  - The tab roots (/wardrobe, /outfits, /calendar) opened as a document are
 *    stale-while-revalidate: the cached copy at once, kept only until the
 *    page (freshness.js) reads it was cached through Navigation Timing and
 *    asks for the server's behind it (REVALIDATE_PAGE), which swaps it in
 *    or offers it when it differs.
 *  - Every other page and every htmx request is NetworkFirst with a short
 *    timeout: fresh when the server is quick, the last copy (stamped, so the
 *    page can say how old it is) when it is not, /offline.html when there is
 *    none. Fragments are keyed apart from pages. Navigations use the
 *    navigation preload response, so the request is already on the wire
 *    while a cold worker boots.
 *  - The page cache holds one account's pages (src/web/page-cache.ts). It
 *    and the image cache are the session's caches (SESSION_CACHES), dropped
 *    together when a session starts or ends here, and when a page rendered
 *    for another account arrives. Every drop starts a new generation, and an
 *    answer to a request started in an older one is never stored.
 *  - Versioned scripts and styles are StaleWhileRevalidate; garment images
 *    are CacheFirst so recently viewed items render offline. Outfit selfies
 *    are never the worker's to cache (the browser's HTTP cache holds them).
 *  - WARM_PAGES (from pwa.js, at most once a day): the account's whole
 *    wardrobe, its pages and thumbs, fetched into the session caches through
 *    the same plugins, so it reads offline (src/web/shell/offline-warm.md).
 *  - Anything unmatched (other POSTs, /healthz) goes straight to the network.
 *
 * Built by `npm run generate:sw` with NODE_ENV=production, which strips
 * Workbox's development logging and assertions; the console.* calls here are
 * the worker's only logs.
 */

declare const self: ServiceWorkerGlobalScope;

// https://developer.chrome.com/docs/workbox/modules/workbox-core#clients_claim
// Top level on purpose: once the user accepts an update (SKIP_WAITING below)
// the new worker must take the open pages so `controlling` fires and
// pwa.js can reload.
clientsClaim();

// https://developer.chrome.com/docs/workbox/modules/workbox-navigation-preload
// The browser starts a navigation's request in parallel with booting the
// worker (iOS and Android stop idle workers within seconds, so most cold
// opens boot one). Both page strategies fetch through StrategyHandler.fetch,
// which answers a navigation with event.preloadResponse when there is one:
// NetworkFirst keeps its 3 s timeout, cache write and offline fallback, and
// a tab root revalidates with it. Only those two routes handle GET
// navigations, so every preload is consumed.
navigationPreload.enable();

const FALLBACK_HTML_URL = '/offline.html';
// v2 since 2026-09-26: copies are stamped and owned (pageStore below);
// pages-v1 held neither and is retired on activate.
const PAGES_CACHE = 'pages-v2';
// v2 since 2026-09-28 (#226): dropped with the session. images-v1 outlived
// every sign-out, so it may hold a previous account's photos; it is retired
// on activate.
const IMAGES_CACHE = 'images-v2';

/**
 * Every cache that holds what a session loaded: nothing one account's pages
 * showed may reach the next. dropSession empties them all at once, so a
 * cache added here is dropped on every session change; one that holds an
 * account's pages or photos and is missing here outlives the session. Each
 * strategy writing into one refuses an answer from an older generation.
 */
const SESSION_CACHES = [PAGES_CACHE, IMAGES_CACHE];

// Static URLs carry `?v=<build>` (src/web/layout/layout.tsx); the precache is already keyed
// by content hash, so the query must not stop a precached file matching.
precacheAndRoute(self.__WB_MANIFEST, {
  ignoreURLParametersMatching: [/^utm_/, /^fbclid$/, /^v$/],
});

// Bookkeeping kept inside the pages cache, so dropping the cache drops it
// too. Off-origin keys: no page request can ever match one.
const OWNER_KEY = 'https://page-cache.invalid/owner';
const ACTIVATED_AT_KEY = 'https://page-cache.invalid/activated-at';
// When the last warm ran to its end (warmPages): a drop takes it, so the
// first page after a sign-in warms the new account.
const WARMED_AT_KEY = 'https://page-cache.invalid/warmed-at';

async function readRecord(key: string): Promise<string | undefined> {
  const cache = await self.caches.open(PAGES_CACHE);
  return (await cache.match(key))?.text();
}

async function writeRecord(key: string, value: string): Promise<void> {
  const cache = await self.caches.open(PAGES_CACHE);
  await cache.put(key, new Response(value));
}

interface RevalidationResult {
  outcome: Revalidation;
  /** When the server's answer arrived (epoch ms). */
  fetchedAt: number;
  /** The server's page, when it differs from the cached copy. */
  html?: string;
}

/**
 * The session caches' generation (#121, #226). Every drop starts a new one; a
 * page or image request records the one it started in (handlerWillStart in
 * pageStore and imageStore), and its answer is stored, or claims the cache,
 * only while that generation is still current. So a slow answer fetched for
 * the account before a sign-out, a sign-in or an account switch never lands
 * in the next session's cache. In memory on purpose: a stopped worker takes
 * its in-flight requests with it, so a new one has nothing older to refuse.
 */
let generation = 0;

/**
 * The generation each warm request belongs to: its run's (#286). drainWarm
 * awaits between its generation check and a job's start, so a drop can fall
 * there; a job stamped with the generation current at its start would then
 * be the next session's, and store the previous account's page or thumb in
 * it. Keyed by the Request handed to handleAll, which handlerWillStart gets.
 */
const warmRunOf = new WeakMap<Request, number>();

/**
 * What a page or image request records in handlerWillStart: a warm's run,
 * else the generation it starts in.
 */
function generationFor(request: Request): number {
  return warmRunOf.get(request) ?? generation;
}

/** The generation a request recorded in its handlerWillStart. */
function startedIn(state: { generation?: unknown } | undefined): number {
  return Number(state?.generation ?? -1);
}

/** True, and logged, when an answer's request started before the last drop. */
function isStale(since: number, path: string): boolean {
  if (since === generation) return false;
  console.info(
    `[sw] ${path} answered from generation ${since}, now ${generation}: not stored`,
  );
  return true;
}

// Serializes the drops and the owner claims, so a claim's generation check
// and its owner write never straddle a drop. The chain swallows a failure so
// the next step still runs; the caller still receives it through `run`.
let ownership: Promise<unknown> = Promise.resolve();

function serialized<T>(work: () => Promise<T>): Promise<T> {
  const run = ownership.then(work);
  ownership = run.catch(() => undefined);
  return run;
}

/**
 * Drops everything this device holds for the previous session: every
 * session cache, whoever's pages and photos they held. Then warms the
 * offline page again for whoever is signed in now (it is a rendered view,
 * with the signed-in chrome). The new generation starts at once, before the
 * drop waits its turn: a request that starts from here on is the new
 * session's. Every session change goes through here, or through
 * emptySessionCaches when the lock is already held (claimPageCache).
 */
function dropSession(event: ExtendableEvent, reason: string): Promise<void> {
  generation += 1;
  return serialized(() => emptySessionCaches(event, reason));
}

/** Holds the ownership lock; the caller has started the new generation. */
async function emptySessionCaches(
  event: ExtendableEvent,
  reason: string,
): Promise<void> {
  await Promise.all(SESSION_CACHES.map((name) => self.caches.delete(name)));
  console.info(
    `[sw] ${reason}: ${SESSION_CACHES.join(', ')} dropped (generation ${generation})`,
  );
  event.waitUntil(rewarmOfflinePage(event));
}

async function rewarmOfflinePage(event: ExtendableEvent): Promise<void> {
  try {
    await Promise.all(
      offlinePage.handleAll({
        event,
        request: new Request(FALLBACK_HTML_URL),
      }),
    );
  } catch (error) {
    console.warn('[sw] could not re-warm the offline page', error);
  }
}

/**
 * The cache holds one account's pages. The worker cannot read the httpOnly
 * session cookie, so it learns the account from each page it stores
 * (X-Page-Account, set by the server on every HTML answer). A page for
 * another account, from a sign-in this worker never saw, empties the cache
 * before it is written. With the drops when a session starts or ends
 * (sessionBoundaryHandler), a cached page is only ever served to the session
 * it was rendered for.
 *
 * False, with nothing written, when the request started in an older
 * generation: the cache has been dropped since, and the answer belongs to a
 * session that may no longer be this device's (a slow page for account A
 * that lands after signing out and in as B, #121).
 */
function claimPageCache(
  account: string,
  since: number,
  path: string,
  event: ExtendableEvent,
): Promise<boolean> {
  return serialized(async () => {
    if (isStale(since, path)) return false;
    const owner = await readRecord(OWNER_KEY);
    if (owner === account) return true;
    if (owner !== undefined) {
      // This answer is the new session's first word and keeps its place;
      // every other request of the old generation is refused.
      generation += 1;
      await emptySessionCaches(
        event,
        account === ''
          ? 'a signed-out page arrived'
          : 'a page for another account arrived',
      );
    }
    await writeRecord(OWNER_KEY, account);
    return true;
  });
}

// Every page either strategy stores, after the 200 filter: a rendered page
// (isRenderedPage: an image or a download opened as a document says nothing
// about who is signed in, and a selfie must never be stored), answering a
// request of the current generation, owner-checked and stamped with when it
// arrived. A followed redirect is not stored under the URL that redirected:
// the body is another page's. One that landed on the login page (a boosted
// tap after the session ended elsewhere: a password changed on another
// device, the account deleted) still tells who is signed in here, nobody, so
// the cache is claimed for nobody and another account's pages go. A document
// load sees the same through the login page it lands on, which is stored
// like any page.
//
// The generation is taken in handlerWillStart, before the request (the
// navigation preload included, which skips requestWillFetch), into the state
// Workbox keeps per plugin and request (generationFor: a warm's request takes
// its run's); a StrategyHandler built by hand (revalidateForPage) must run
// handlerWillStart itself.
const pageStore: WorkboxPlugin = {
  handlerWillStart: async ({ request, state }) => {
    if (state) state.generation = generationFor(request);
  },
  cacheWillUpdate: async ({ request, response, event, state }) => {
    const since = startedIn(state);
    const path = new URL(request.url).pathname;
    if (response.redirected) {
      if (sentToLogin(response)) await claimPageCache('', since, path, event);
      return null;
    }
    if (!isRenderedPage(response.headers)) return null;
    const claimed = await claimPageCache(
      pageAccount(response.headers),
      since,
      path,
      event,
    );
    if (!claimed) return null;
    return copyResponse(response, (init) => {
      const headers = new Headers(init.headers);
      const cachedAtMs = String(Date.now());
      headers.set(CACHED_AT_HEADER, cachedAtMs);
      // A document's own script cannot read this header directly, only
      // Server-Timing (page-cache.ts's CACHED_AT_TIMING_NAME): freshness.js
      // reads it back through Navigation Timing and asks for
      // REVALIDATE_PAGE itself once it does.
      const timing = headers.get('Server-Timing');
      const cacheEntry = `${CACHED_AT_TIMING_NAME};desc="${cachedAtMs}"`;
      headers.set(
        'Server-Timing',
        timing ? `${timing}, ${cacheEntry}` : cacheEntry,
      );
      return { ...init, headers };
    });
  },
};

// A copy is only read back for the account that owns the cache. Workbox
// writes an answer after cacheWillUpdate has claimed for it, so a drop can
// still fall between the two: the copy then lands in the emptied cache,
// rendered for an account that no longer (or not yet) owns it, and this is
// what keeps it from ever being served. Nor is a copy stored before this
// worker activated, by any strategy: an older build rendered it, and its
// <head> (the importmap, the asset URLs) must not meet this build's
// precached scripts, not even as NetworkFirst's offline answer (the offline
// page answers then, read by the catch handler, not through here). Such a
// copy is deleted: the next visit or warm stores this build's. `request` is
// the cache key here (cacheKeyWillBeUsed has run).
const servedCopies: WorkboxPlugin = {
  cachedResponseWillBeUsed: async ({ cacheName, request, cachedResponse }) => {
    if (!cachedResponse) return null;
    const path = new URL(request.url).pathname;
    if (!(await isOwned(cachedResponse, path))) return null;
    if (await isFromAnOlderBuild(cachedResponse)) {
      await (await self.caches.open(cacheName)).delete(request);
      console.info(`[sw] ${path}: copy from before activation deleted`);
      return null;
    }
    return cachedResponse;
  },
};

async function isFromAnOlderBuild(copy: Response): Promise<boolean> {
  const activatedAt = Number((await readRecord(ACTIVATED_AT_KEY)) ?? 0);
  return cachedAt(copy.headers) <= activatedAt;
}

async function isOwned(copy: Response, path: string): Promise<boolean> {
  const owner = await readRecord(OWNER_KEY);
  if (pageAccount(copy.headers) === owner) return true;
  console.warn(`[sw] ${path}: cached for another account, not served`);
  return false;
}

// Every page the cache holds follows these: the key rule (a fragment `|hx`
// never answers a page and the other way round), the store and read rules.
const pageRules: WorkboxPlugin[] = [
  {
    cacheKeyWillBeUsed: async ({ request }) =>
      pageCacheKey(request.url, request.headers),
  },
  new CacheableResponsePlugin({ statuses: [200] }),
  pageStore,
  servedCopies,
];

// Pages a user visits beyond a warmed wardrobe: shared wardrobes, filtered
// grids, other weeks, wishlist items, the other tabs' pages.
const VISITED_PAGES = 100;

// Shared by both page strategies, which share the cache: the rules and one
// expiration, sized for a warm at its caps (WARM_PAGE_CAP, #286) and the
// pages visited besides, so a warm never evicts what the user opened.
const pagePlugins: WorkboxPlugin[] = [
  ...pageRules,
  new ExpirationPlugin({
    maxEntries: WARM_PAGE_CAP + VISITED_PAGES,
    purgeOnQuotaError: true,
  }),
];

const pages = new NetworkFirst({
  cacheName: PAGES_CACHE,
  networkTimeoutSeconds: 3,
  plugins: pagePlugins,
});

// The offline page is stored by the page rules alone, never the expiration:
// ExpirationPlugin only expires what it saw stored, so the fallback, written
// at install and before any warm, is never the oldest entry it evicts. Only
// the install and a drop's re-warm write it.
const offlinePage = new NetworkFirst({
  cacheName: PAGES_CACHE,
  plugins: pageRules,
});

/**
 * The server's copy, stored through the page plugins (the key, the 200
 * filter, the generation and owner checks, the stamp), never the cached
 * one: a warm wants a fresh copy or a failure it can stop on, where
 * NetworkFirst would answer an unreachable server with the old copy.
 */
class PageRefresh extends Strategy {
  protected _handle(request: Request, handler: StrategyHandler) {
    return handler.fetchAndCachePut(request);
  }
}

const pageWarmer = new PageRefresh({
  cacheName: PAGES_CACHE,
  plugins: pagePlugins,
});

/**
 * Fetches the server's copy of a cached page, stores it and compares it with
 * the cached one. The outcome is only told once the cache holds the new copy
 * (or has been dropped), so a page that reloads on it finds that.
 */
async function revalidate(
  handler: StrategyHandler,
  request: Request,
  cached: Response,
): Promise<RevalidationResult> {
  const path = new URL(request.url).pathname;
  let fresh: FreshPage | undefined;
  try {
    const response = await handler.fetch(request);
    await handler.cachePut(request, response.clone());
    fresh = {
      status: response.status,
      redirected: response.type === 'opaqueredirect' || response.redirected,
      account: pageAccount(response.headers),
      body: response.status === 200 ? await response.text() : '',
    };
  } catch (error) {
    console.warn(`[sw] could not revalidate ${path}`, error);
  }
  const outcome = revalidationOutcome(
    { account: pageAccount(cached.headers), body: await cached.text() },
    fresh,
  );
  if (outcome === 'signed-out' || outcome === 'account-changed') {
    await dropSession(handler.event, `${path} revalidated ${outcome}`);
  }
  if (outcome !== 'current') {
    console.info(`[sw] ${path} revalidated: ${outcome}`);
  }
  return {
    outcome,
    fetchedAt: Date.now(),
    html: outcome === 'updated' ? fresh?.body : undefined,
  };
}

/**
 * The tab roots on a document load (servesStaleWhileRevalidate): the cached
 * copy at once. Without a copy it is NetworkFirst, and so it is for a copy
 * stored before this worker activated, which servedCopies never hands back.
 *
 * Nothing here starts a revalidation: public/js/freshness.js reads the
 * served-from-cache stamp itself, through Navigation Timing (Server-Timing,
 * CACHED_AT_TIMING_NAME in page-cache.ts), and asks for REVALIDATE_PAGE
 * itself, the same request a reconnect makes (#240). A worker that instead
 * started one here and remembered its promise, for the page to collect
 * later by asking with the navigation's resultingClientId, lost that memory
 * on WebKit, which can stop an idle worker between this fetch event and the
 * page's next message; asking fresh needs nothing to have survived.
 */
class StaleTabRoot extends Strategy {
  protected async _handle(
    request: Request,
    handler: StrategyHandler,
  ): Promise<Response> {
    const cached = await handler.cacheMatch(request);
    if (!cached) return pages.handle({ event: handler.event, request });
    const path = new URL(request.url).pathname;
    const ageSeconds = Math.round(
      (Date.now() - cachedAt(cached.headers)) / 1000,
    );
    console.info(`[sw] ${path} opened from the cache (${ageSeconds} s old)`);
    return cached;
  }
}

const tabRoots = new StaleTabRoot({
  cacheName: PAGES_CACHE,
  plugins: pagePlugins,
});

// Never the MCP endpoint (bypassesWorker): a navigation to it would
// otherwise be a page to this worker.
const isPageRequest = ({ request, url }: { request: Request; url: URL }) =>
  !bypassesWorker(url) &&
  (request.mode === 'navigate' || request.headers.get('HX-Request') === 'true');

// Signing in (POST /auth/login, /auth/register) and out (POST /auth/logout,
// /auth/delete-account) change whose pages and photos this device may show:
// once the server has answered, the session caches go, so no session is ever
// served the previous one's, online or off. The server also sends
// Clear-Site-Data: "cache" whenever a session ends, which not every browser
// applies to Cache Storage. Registered before the page routes: the first
// match wins.
const SESSION_STARTS = new Set(['/auth/login', '/auth/register']);
const SESSION_ENDS = new Set(['/auth/logout', '/auth/delete-account']);

const isSessionBoundary = ({ url }: { url: URL }) =>
  url.origin === self.location.origin &&
  (SESSION_STARTS.has(url.pathname) || SESSION_ENDS.has(url.pathname));

type SessionChange = 'session started' | 'session ended' | 'session revoked';

/**
 * What an auth POST's answer did to this device's session, read from the
 * page its redirect landed on (sessionBoundaryHandler follows it). A
 * redirect means it changed. A refusal (a wrong password, a taken email)
 * re-renders the form with a 4xx and changes nothing, unless it says
 * X-Session-Ended (endedSession): the cookie it was sent with no longer
 * opened a session (revoked elsewhere, expired), and the server cleared it
 * on this very answer (#131). The login form stays open to a signed-in
 * user, so this is a wrong password typed after the account's password
 * changed on another device.
 *
 * A sign-in keeps the push subscription even when its redirect also ended
 * a dead session (X-Session-Ended beside the new cookie): the worker sees
 * the page the redirect landed on, not the redirect's own headers, and it
 * need not. The next signed-in page re-sends the subscription
 * (syncSubscription, public/js/push.js), which moves the device's row to
 * the new account with its reminders off (upsertDevice,
 * src/web/push/queries.ts), so the previous account's notifications stop.
 */
function sessionChange(url: URL, response: Response): SessionChange | null {
  if (response.redirected) {
    return SESSION_ENDS.has(url.pathname) ? 'session ended' : 'session started';
  }
  return endedSession(response.headers) ? 'session revoked' : null;
}

/**
 * Follows the redirect in the worker, never as the navigation's opaque
 * redirect (#239). A navigation's request has redirect mode 'manual', so
 * fetching it as is answers with an opaque redirect, and WebKit (Safari,
 * every iOS browser) loses an opaque redirect that carries
 * Clear-Site-Data: the fetch never settles, and signing out, deleting the
 * account or signing in over another account hung on the POST
 * (NetworkResourceLoader::didFinishWithRedirectResponse finishes the load
 * while the header's clearing still holds the response back). A followed
 * one settles everywhere, and Chromium applies Clear-Site-Data on a
 * followed redirect too. `new Request` with an init turns 'navigate' into
 * 'same-origin'; every auth redirect is same-origin.
 */
async function fetchFollowingRedirects(request: Request): Promise<Response> {
  return fetch(new Request(request, { redirect: 'follow' }));
}

/**
 * The answer for the request the page made. A navigation may not be
 * answered with a followed redirect's page (its redirect mode is 'manual':
 * the browser would fail the load, and the URL would stay the POST's), so
 * it gets a 303 to where the redirect landed, which the browser follows
 * like the server's own: a GET, through the page routes. That page is
 * fetched twice, once here to learn the outcome; its body is dropped. An
 * htmx request follows redirects itself and takes the page as it is.
 */
function answerFor(request: Request, response: Response): Response {
  if (!response.redirected || request.redirect === 'follow') return response;
  void response.body?.cancel();
  return Response.redirect(response.url, 303);
}

/** Dropped before answering, so the redirect's next page cannot race it. */
async function changeSession(
  event: ExtendableEvent,
  reason: string,
  ended: boolean,
): Promise<void> {
  await dropSession(event, reason);
  if (ended) event.waitUntil(dropPushSubscription());
}

const sessionBoundaryHandler = async ({
  request,
  url,
  event,
}: RouteHandlerCallbackOptions) => {
  let response: Response;
  try {
    response = await fetchFollowingRedirects(request);
  } catch (error) {
    // No answer, but the server may have acted on the post: the connection
    // can drop after it signed out (or in) and before the followed page
    // arrived. Fail safe: a needless drop costs a refetch, a missed one
    // leaves another session's pages and photos cached. Then the catch
    // handler answers, as for any unreachable server (the offline page for
    // a navigation, if the drop's re-warm has put it back; else an error).
    console.warn(`[sw] ${url.pathname} got no answer`, error);
    await changeSession(
      event,
      `${url.pathname} got no answer, the session may have changed`,
      SESSION_ENDS.has(url.pathname),
    );
    throw error;
  }
  const change = sessionChange(url, response);
  if (change) {
    await changeSession(event, change, change !== 'session started');
  }
  return answerFor(request, response);
};

// A signed-out device receives nobody's notifications: the subscription goes
// with the session. The server's row is removed when its push service next
// answers 410 (src/web/push/sender.ts), or with the account. Signing in
// again, the profile page offers to enable them (no new prompt: the
// permission stays). A session ended away from this device (a password
// changed elsewhere, which also removes the row) never passes through here:
// the login page it lands on drops the subscription (<push-signed-out>,
// public/js/push.js).
async function dropPushSubscription(): Promise<void> {
  try {
    const subscription = await self.registration.pushManager.getSubscription();
    if (!subscription) return;
    await subscription.unsubscribe();
    console.info('[sw] session ended, push subscription dropped');
  } catch (error) {
    console.warn('[sw] could not drop the push subscription', error);
  }
}

// POST only: GET /auth/logout is the confirmation page old cached pages
// link to, and GET /auth/login the form; neither changes a session.
registerRoute(isSessionBoundary, sessionBoundaryHandler, 'POST');

registerRoute(
  ({ request }) => servesStaleWhileRevalidate(request, self.location.origin),
  tabRoots,
);
registerRoute(isPageRequest, pages);

// First-party scripts and styles are `?v=`-versioned and served immutable by
// app.ts, so serving the cached copy while refreshing is safe.
registerRoute(
  ({ url, request }) =>
    url.origin === self.location.origin &&
    (url.pathname === '/bundle.css' ||
      url.pathname.startsWith('/js/') ||
      url.pathname.startsWith('/vendor/') ||
      url.pathname.startsWith('/modules/')) &&
    request.method === 'GET',
  new StaleWhileRevalidate({
    cacheName: 'assets-v1',
    plugins: [
      new CacheableResponsePlugin({ statuses: [200] }),
      new ExpirationPlugin({ maxEntries: 60, purgeOnQuotaError: true }),
    ],
  }),
);

// An image is stored only for a request of the current generation (#226): a
// photo the previous account's page asked for, landing after a sign-out, a
// sign-in or an account switch, never enters the next session's cache.
// Workbox writes after cacheWillUpdate, so a drop can still fall between the
// two; cacheDidUpdate then takes the copy out again. Either that check sees
// the new generation, or the write finished before the drop began, which
// deletes it with the cache.
const imageStore: WorkboxPlugin = {
  handlerWillStart: async ({ request, state }) => {
    if (state) state.generation = generationFor(request);
  },
  cacheWillUpdate: async ({ request, response, state }) =>
    isStale(startedIn(state), new URL(request.url).pathname) ? null : response,
  cacheDidUpdate: async ({ cacheName, request, state }) => {
    if (startedIn(state) === generation) return;
    const cache = await self.caches.open(cacheName);
    await cache.delete(request);
    console.info(
      `[sw] ${new URL(request.url).pathname} stored across a drop: deleted`,
    );
  },
};

// Cutouts and photos a user opens beyond a warm's thumbs.
const VISITED_IMAGES = 200;

const CUTOUT_PREFIX = '/file/nobg/';
const THUMB_PREFIX = '/file/thumb/';

// A warm stores thumbs, never cutouts (owner decision on #178), so offline a
// garment page whose cutout was never viewed draws the garment from its
// thumb: the same photo (name, version, key and signature are the query;
// only the variant's path differs), scaled up. Only once the network has
// failed: online the cutout itself loads.
const cutoutStandIn: WorkboxPlugin = {
  handlerDidError: async ({ request }) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(CUTOUT_PREFIX)) return undefined;
    const path = url.pathname;
    url.pathname = THUMB_PREFIX + path.slice(CUTOUT_PREFIX.length);
    const cache = await self.caches.open(IMAGES_CACHE);
    const thumb = await cache.match(url.href);
    if (thumb) console.info(`[sw] ${path}: unreachable, its thumb stands in`);
    return thumb;
  },
};

// Garment photos, cutouts, thumbs and share previews (/file/**): public and
// immutable under a versioned URL (src/web/files/routes.ts), so cached bytes
// are never stale and nothing ages out (an age limit only forced a refetch,
// each a statement on the server), but a session's all the same
// (SESSION_CACHES). Sized for a warmed wardrobe's thumbs (WARM_IMAGE_CAP,
// #286) and the cutouts and photos visited besides. Only <img> loads are
// routed here, so a watermark preview fetched by a share scraper never
// fills the quota; a warm's thumbs go through images.handleAll. Outfit selfies (/selfies/**,
// their owner's alone) match no route: the worker never stores one.
const images = new CacheFirst({
  cacheName: IMAGES_CACHE,
  plugins: [
    new CacheableResponsePlugin({ statuses: [200] }),
    imageStore,
    cutoutStandIn,
    new ExpirationPlugin({
      maxEntries: WARM_IMAGE_CAP + VISITED_IMAGES,
      purgeOnQuotaError: true,
    }),
  ],
});

registerRoute(
  ({ url, request }) =>
    url.origin === self.location.origin &&
    url.pathname.startsWith('/file/') &&
    request.destination === 'image',
  images,
);

// Caches nothing reads any more: the in-browser background-removal model's
// (its runtime and ~42 MB of model and WASM, filled by workers before
// 2026-09-26, when the server took over background removal), pages-v1
// (unstamped, unowned pages; see PAGES_CACHE) and images-v1 (kept across
// sessions; see IMAGES_CACHE).
const RETIRED_CACHES = [
  'bg-removal-models',
  'bg-removal-models-v2',
  'bg-removal-runtime-modules-v1',
  'pages-v1',
  'images-v1',
];

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // StaleTabRoot serves stale-first only what this build's worker
      // stored after this moment.
      await writeRecord(ACTIVATED_AT_KEY, String(Date.now()));
      const deleted = await Promise.all(
        RETIRED_CACHES.map((name) => self.caches.delete(name)),
      );
      const count = deleted.filter(Boolean).length;
      if (count > 0) console.info(`[sw] dropped ${count} retired cache(s)`);
    })(),
  );
});

// The offline page is a rendered view, not a public/ file, so it cannot be
// precached; warm it into the pages cache at install instead.
warmStrategyCache({ urls: [FALLBACK_HTML_URL], strategy: offlinePage });

// https://developer.chrome.com/docs/workbox/managing-fallback-responses
// Runs when a matched route's handler fails: for a page (navigation or a
// boosted link, which swaps the whole body) serve the offline page; a
// fragment request fails instead, which htmx reports as htmx:sendError and
// public/js/connectivity.js turns into the offline banner.
setCatchHandler(async ({ request }) => {
  const wantsPage =
    request.mode === 'navigate' || request.headers.get('HX-Boosted') === 'true';
  if (wantsPage) {
    const cache = await self.caches.open(PAGES_CACHE);
    const fallback = await cache.match(FALLBACK_HTML_URL);
    if (fallback && (await isOwned(fallback, FALLBACK_HTML_URL))) {
      return fallback;
    }
  }
  return Response.error();
});

// URL.canParse is Safari 17+; the installed app still meets iOS 16.
function isOwnUrl(value: string): boolean {
  try {
    return new URL(value).origin === self.location.origin;
  } catch {
    return false;
  }
}

/**
 * REVALIDATE_PAGE: a page showing a cached copy is back online (frontend-
 * pwa.md: refetch on reconnect) and asks for the server's, compared with the
 * cached copy like a tab root's revalidation. A display that is a fragment
 * (the wardrobe's filters, which push their URL) asks for the fragment: the
 * same request htmx made, so it meets its `|hx` copy and the server answers
 * with the fragment the page swaps back into its target.
 */
async function revalidateForPage(
  event: ExtendableMessageEvent,
  url: string,
  fragment: boolean,
  port: MessagePort,
): Promise<void> {
  if (!isOwnUrl(url)) {
    console.warn('[sw] REVALIDATE_PAGE for another origin, ignored');
    return;
  }
  const request = new Request(
    url,
    fragment ? { headers: { 'HX-Request': 'true' } } : undefined,
  );
  // A strategy's handler outside a fetch event: it applies the page cache's
  // plugins (key, store and read rules) and holds the event open until
  // destroyed. Strategy.handle runs handlerWillStart; here it is ours to run
  // (pageStore takes the generation in it).
  const handler = new StrategyHandler(tabRoots, { event, request });
  try {
    await handler.runCallbacks('handlerWillStart', { event, request });
    const cached = await handler.cacheMatch(request);
    const result: RevalidationResult = cached
      ? await revalidate(handler, request, cached)
      : { outcome: 'failed', fetchedAt: Date.now() };
    port.postMessage({ state: 'revalidated', ...result });
  } finally {
    await handler.doneWaiting().catch((error: unknown) => {
      console.warn('[sw] revalidation cleanup failed', error);
    });
    handler.destroy();
  }
}

/**
 * WARM_PAGES (#286, src/web/shell/offline-warm.md): the signed-in account's
 * whole wardrobe, read offline. The server lists it (GET /offline/warm: the
 * session's own wardrobe, never a shared one); the worker removes the
 * cached pages of garments and outfits no longer on it, then fetches, two at
 * a time, every page and thumb it lacks or holds older than a day, through
 * the session caches' own plugins: a page is owner-checked and stamped, and
 * nothing a request of an older generation brought back is stored. A drop
 * (sign-out, sign-in, another account's page) mid-warm stops it, and every
 * request of the run, in flight or started after, is refused by the
 * generation check (warmRunOf). An answer saying the session is over (the
 * gate's 401, X-Session-Ended) is a drop of its own. Runs at most once a
 * day (WARMED_AT_KEY, which a drop takes with the cache, so a new session
 * warms at once, and so does a new worker: WARMED_AT_KEY older than
 * ACTIVATED_AT_KEY is due); only a run that reached its end with no answer
 * but a 200 or a 404 is recorded, so the next page resumes any other,
 * skipping what is already fresh.
 */
type WarmStop =
  | 'the session changed'
  | 'the session ended'
  | 'unreachable'
  | 'storage budget reached';

interface WarmTally {
  pages: number;
  images: number;
  /** Already cached and young enough: not fetched. */
  fresh: number;
  /** Pages of garments and outfits gone from the list. */
  removed: number;
  /** Answered 404: deleted since the list was made. */
  refused: number;
  /** Answered with another error (a 500, a 503): retried by the next run. */
  failed: number;
}

interface WarmJob {
  strategy: Strategy;
  request: Request;
  tally: 'pages' | 'images';
}

const WARM_CONCURRENCY = 2;
// navigator.storage.estimate() is read every few fetches, not before each.
const USAGE_CHECK_EVERY = 10;

/** The warm running now, if any. */
let warming: Promise<void> | undefined;
/** A WARM_PAGES arrived while one ran: run again once it ends. */
let warmAgain = false;

/**
 * One warm at a time. A WARM_PAGES meanwhile (another tab, or the next
 * account's first page after a drop stopped this run) runs once more when
 * it ends, which costs one record read when the first run completed.
 */
function warmPages(event: ExtendableMessageEvent): Promise<void> {
  if (warming) {
    warmAgain = true;
    return warming;
  }
  warming = (async () => {
    do {
      warmAgain = false;
      await runWarm(event).catch((error: unknown) => {
        console.warn('[sw] warm failed', error);
      });
    } while (warmAgain);
  })().finally(() => {
    warming = undefined;
  });
  return warming;
}

async function runWarm(event: ExtendableMessageEvent): Promise<void> {
  const lastRun = Number((await readRecord(WARMED_AT_KEY)) ?? 0);
  const activatedAt = Number((await readRecord(ACTIVATED_AT_KEY)) ?? 0);
  const sinceLastRun = Date.now() - lastRun;
  // A warm before this worker activated stored an older build's pages,
  // which servedCopies no longer serves: due at once, whatever its age.
  if (sinceLastRun < WARM_MAX_AGE_MS && lastRun > activatedAt) {
    console.debug(
      `[sw] warm not due: last ran ${Math.round(sinceLastRun / 60_000)} min ago`,
    );
    return;
  }
  const startedAt = Date.now();
  const { usage: usageAtStart = 0 } = await storageEstimate();
  const listed = await fetchWarmList(event);
  if (!listed) return;
  // The claim may have started a generation (another account's caches
  // dropped first): the run is that generation's, and ends with it.
  const run = generation;
  const tally: WarmTally = {
    pages: 0,
    images: 0,
    fresh: 0,
    removed: 0,
    refused: 0,
    failed: 0,
  };
  tally.removed = await removeGonePages(listed.list, run);
  const jobs = await dueJobs(listed.list, listed.account, tally);
  const stop = await drainWarm(event, jobs, run, tally, usageAtStart);
  // Complete only when it reached its end with every answer a 200 or a 404
  // (deleted since): a 500 or a 503 leaves the run unrecorded, so the next
  // page fetches what failed.
  const complete = stop === undefined && tally.failed === 0;
  if (complete) await recordWarmed(run);
  const { usage = 0, quota = 0 } = await storageEstimate();
  const summary =
    `${tally.pages} pages, ${tally.images} images in ` +
    `${((Date.now() - startedAt) / 1000).toFixed(1)} s (${tally.fresh} fresh, ` +
    `${tally.removed} removed, ${tally.refused} refused, ` +
    `${tally.failed} failed, added ${formatBytes(usage - usageAtStart)}, ` +
    `usage ${formatBytes(usage)} of ${formatBytes(quota)})`;
  if (complete) console.info(`[sw] warmed ${summary}`);
  else if (stop === undefined) {
    console.warn(
      `[sw] warm incomplete, ${tally.failed} failed: warmed ${summary}`,
    );
  } else if (stop === 'storage budget reached') {
    // Not recorded: the next page warms on from here, with a budget of its
    // own. The list's caps bound what all of them store.
    console.warn(`[sw] warm stopped, ${stop}: warmed ${summary}`);
  } else console.info(`[sw] warm stopped, ${stop}: warmed ${summary}`);
}

/**
 * Whether a warm's answer says this device's session is over. A worker's
 * fetch is no navigation (Sec-Fetch-Mode: cors), so the session gate
 * refuses it with a 401, never a redirect to the login page; a revoked
 * cookie's answer also says X-Session-Ended and clears it, which the
 * worker sees nowhere else (handleAll bypasses sessionBoundaryHandler).
 */
function sessionEndedBy(response: Response): boolean {
  return response.status === 401 || endedSession(response.headers);
}

/**
 * The warm's half of what sessionBoundaryHandler does for a revoked
 * session: the session caches and the push subscription go. Only while the
 * generation the answer was asked in lasts: a later one is another
 * session's, whose caches an older answer must not empty.
 */
async function endWarmedSession(
  event: ExtendableEvent,
  since: number,
  path: string,
): Promise<void> {
  if (since !== generation) return;
  await changeSession(event, `${path} (warm): the session ended`, true);
}

/**
 * The server's warm list, once the session caches are claimed for its
 * account (it says whose it is, like a page): undefined, with nothing
 * stored, when it cannot be had or a drop overtook it. A list refused for
 * want of a session means it ended away from this device: the session's
 * caches go (endWarmedSession).
 */
async function fetchWarmList(
  event: ExtendableEvent,
): Promise<{ list: WarmList; account: string } | undefined> {
  const since = generation;
  let response: Response;
  try {
    response = await fetch(WARM_LIST_PATH, {
      headers: { [WARM_REQUEST_HEADER]: '1' },
      cache: 'no-store',
    });
  } catch (error) {
    console.info('[sw] warm list unreachable: nothing warmed', error);
    return undefined;
  }
  if (sessionEndedBy(response)) {
    await endWarmedSession(event, since, WARM_LIST_PATH);
    console.info('[sw] warm list: signed out, nothing warmed');
    return undefined;
  }
  const json = response.headers
    .get('Content-Type')
    ?.startsWith('application/json');
  const list =
    response.ok && json ? parseWarmList(await response.json()) : undefined;
  const account = pageAccount(response.headers);
  if (!list || account === '') {
    console.warn(`[sw] warm list refused (${response.status}): nothing warmed`);
    return undefined;
  }
  const claimed = await claimPageCache(account, since, WARM_LIST_PATH, event);
  return claimed ? { list, account } : undefined;
}

/**
 * Deletes the cached pages of the account's garments and outfits that are
 * on neither of the list's page lists: deleted or archived since. Under the
 * ownership lock, and only while the run's generation lasts, so it never
 * touches the next session's pages.
 */
function removeGonePages(list: WarmList, run: number): Promise<number> {
  const listed = new Set(
    [...list.pages, ...list.keep].map(
      (path) => new URL(path, self.location.origin).href,
    ),
  );
  return deleteCachedPages(
    run,
    (url) => isWarmedDetailPage(url) && !listed.has(url.href),
  );
}

/**
 * Deletes the cached pages (and their `|hx` fragments) whose URL `isGone`
 * accepts, under the ownership lock and only while the run's generation
 * lasts. A fragment's key (`/wardrobe/12|hx`) is its page's fate too.
 */
function deleteCachedPages(
  run: number,
  isGone: (url: URL) => boolean,
): Promise<number> {
  return serialized(async () => {
    if (generation !== run) return 0;
    const cache = await self.caches.open(PAGES_CACHE);
    const gone = (await cache.keys()).filter((key) => {
      const url = new URL(pageUrlOfCacheKey(key.url));
      return url.origin === self.location.origin && isGone(url);
    });
    await Promise.all(gone.map((key) => cache.delete(key)));
    return gone.length;
  });
}

/**
 * What the list names and the caches lack: a page without a copy, or with
 * one older than a day, another account's, or stored before this worker
 * activated (an older build's <head>); a thumb not cached (thumbs are
 * immutable). The rest counts as fresh.
 */
async function dueJobs(
  list: WarmList,
  account: string,
  tally: WarmTally,
): Promise<WarmJob[]> {
  const [pagesCache, imagesCache] = await Promise.all([
    self.caches.open(PAGES_CACHE),
    self.caches.open(IMAGES_CACHE),
  ]);
  const activatedAt = Number((await readRecord(ACTIVATED_AT_KEY)) ?? 0);
  const marked = { [WARM_REQUEST_HEADER]: '1' };
  const pageRequests = [
    ...list.pages.map((path) => new Request(path, { headers: marked })),
    // As the grid's sentinel asks, so each lands under its `|hx` key.
    ...list.fragments.map(
      (path) =>
        new Request(path, { headers: { ...marked, 'HX-Request': 'true' } }),
    ),
  ];
  const pageJobs: WarmJob[] = [];
  for (const request of pageRequests) {
    const copy = await pagesCache.match(
      pageCacheKey(request.url, request.headers),
    );
    const stamp = copy ? cachedAt(copy.headers) : 0;
    const fresh =
      copy !== undefined &&
      pageAccount(copy.headers) === account &&
      stamp > activatedAt &&
      Date.now() - stamp < WARM_MAX_AGE_MS;
    if (fresh) tally.fresh += 1;
    else pageJobs.push({ strategy: pageWarmer, request, tally: 'pages' });
  }
  const imageJobs: WarmJob[] = [];
  for (const path of list.images) {
    const request = new Request(path, { headers: marked });
    if (await imagesCache.match(request)) tally.fresh += 1;
    else imageJobs.push({ strategy: images, request, tally: 'images' });
  }
  // Pages and thumbs side by side, so a warm cut short (the app closed, the
  // network gone) leaves pages with their thumbs rather than one kind only.
  return Array.from(
    { length: Math.max(pageJobs.length, imageJobs.length) },
    (_, i) => [pageJobs[i], imageJobs[i]],
  )
    .flat()
    .filter((job): job is WarmJob => job !== undefined);
}

/**
 * Runs the jobs WARM_CONCURRENCY at a time, through each cache's strategy
 * (handleAll: its plugins, each request stamped with the run's generation,
 * warmRunOf). Stops at the first fetch that fails (the device went offline:
 * the next page resumes), at a drop, at an answer saying the session ended,
 * or once the warm has added WARM_USAGE_BUDGET_BYTES to `usageAtStart`.
 */
async function drainWarm(
  event: ExtendableMessageEvent,
  jobs: WarmJob[],
  run: number,
  tally: WarmTally,
  usageAtStart: number,
): Promise<WarmStop | undefined> {
  let stop: WarmStop | undefined;
  let started = 0;
  const worker = async () => {
    for (let job = jobs.shift(); job && !stop; job = jobs.shift()) {
      if (started % USAGE_CHECK_EVERY === 0) {
        const { usage = 0 } = await storageEstimate();
        if (usage - usageAtStart > WARM_USAGE_BUDGET_BYTES) {
          stop ??= 'storage budget reached';
          return;
        }
      }
      // After the await: a drop meanwhile ends the run here. One that falls
      // later still finds the job stamped with the run (warmRunOf).
      if (generation !== run) {
        stop ??= 'the session changed';
        return;
      }
      started += 1;
      warmRunOf.set(job.request, run);
      try {
        const [response, done] = job.strategy.handleAll({
          event,
          request: job.request,
        });
        const answer = await response;
        await done;
        if (sessionEndedBy(answer)) {
          // Ended by a drop the worker already made (a sign-out between two
          // fetches) is the session changing; one only this answer tells of
          // is ended here.
          if (generation !== run) stop ??= 'the session changed';
          else {
            stop ??= 'the session ended';
            await endWarmedSession(
              event,
              run,
              new URL(job.request.url).pathname,
            );
          }
          return;
        }
        if (answer.ok) tally[job.tally] += 1;
        else if (answer.status === 404) {
          tally.refused += 1;
          // Deleted since the list was made: the 200-only plugin keeps the
          // old copy, which offline would be served for another day.
          // (A thumb's URL is immutable: nothing to delete.)
          if (job.tally === 'pages') {
            const { href } = new URL(job.request.url);
            tally.removed += await deleteCachedPages(
              run,
              (url) => url.href === href,
            );
          }
        }
        else tally.failed += 1;
      } catch {
        stop ??= 'unreachable';
      }
    }
  };
  await Promise.all(Array.from({ length: WARM_CONCURRENCY }, worker));
  // A drop outranks the failures it causes; the run's own drop keeps its
  // reason.
  if (generation !== run && stop !== 'the session ended') {
    stop = 'the session changed';
  }
  return stop;
}

/** Under the lock: never written into the next session's cache. */
function recordWarmed(run: number): Promise<void> {
  return serialized(async () => {
    if (generation === run)
      await writeRecord(WARMED_AT_KEY, String(Date.now()));
  });
}

// StorageManager.estimate() is Safari 17+; the installed app still meets
// iOS 16, where the budget then goes unchecked (the list's caps bound it).
async function storageEstimate(): Promise<StorageEstimate> {
  const storage = self.navigator.storage as StorageManager | undefined;
  return typeof storage?.estimate === 'function' ? storage.estimate() : {};
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
}

// Update flow: pwa.js shows a toast when a new worker is waiting and sends
// SKIP_WAITING when the user taps Reload. No skipWaiting() on install: a
// worker that seizes control mid-session leaves pages holding stale asset
// URLs, which is the black-screen bug the old hard-navigate hack papered over.
// The page's own questions come from public/js/freshness.js, each with a
// MessagePort for the answer; WARM_PAGES from public/js/pwa.js wants none.
self.addEventListener('message', (event) => {
  const type: unknown = event.data?.type;
  const [port] = event.ports;
  if (type === 'SKIP_WAITING') {
    console.log('[sw] SKIP_WAITING received');
    void self.skipWaiting();
  } else if (type === 'REVALIDATE_PAGE' && port) {
    event.waitUntil(
      revalidateForPage(
        event,
        String(event.data.url),
        event.data.fragment === true,
        port,
      ),
    );
  } else if (type === 'WARM_PAGES') {
    event.waitUntil(warmPages(event));
  }
});

// Web Push. The payload is PushPayload (src/web/push/payload.ts), the shape
// the server's sender writes; anything else is dropped with a warning (a
// browser may then show its own "updated in the background" notice).
// https://web.dev/articles/push-notifications-handling-messages
self.addEventListener('push', (event) => {
  const payload = readPushPayload(event.data);
  if (!payload) {
    console.warn('[sw] push message without a readable payload, ignored');
    return;
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      data: { url: payload.url },
    }),
  );
});

function readPushPayload(
  data: PushMessageData | null,
): PushPayload | undefined {
  if (!data) return undefined;
  try {
    return parsePushPayload(data.json());
  } catch {
    // Not JSON: not a message this app sends.
    return undefined;
  }
}

// A tap opens the notification's page: in a window already showing it, else
// in the first open window of the app, else a new one. Never off-origin
// (openNotification).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    openNotification(
      self.clients,
      event.notification.data,
      self.location.origin,
    ),
  );
});
