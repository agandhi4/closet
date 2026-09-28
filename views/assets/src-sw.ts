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
import { pageCacheKey } from '../../src/htmx/fragment-request';
import {
  bypassesWorker,
  CACHED_AT_HEADER,
  cachedAt,
  endedSession,
  type FreshPage,
  pageAccount,
  type Revalidation,
  revalidationOutcome,
  sentToLogin,
  servesStaleWhileRevalidate,
} from '../../src/web/page-cache';
import {
  notificationTarget,
  parsePushPayload,
  type PushPayload,
} from '../../src/web/push/payload';

/**
 * Caching model (public/js/pwa.js and public/js/freshness.js are the page
 * side):
 *  - App shell files under public/ are precached by content hash
 *    (workbox-config.js), so a repeat visit paints from cache.
 *  - The tab roots (/wardrobe, /outfits, /calendar) opened as a document are
 *    stale-while-revalidate: the cached copy at once, the server's behind
 *    it. The page asks what it was given (PAGE_FRESHNESS), says how old it
 *    is, and swaps in or offers the server's copy when it differs.
 *  - Every other page and every htmx request is NetworkFirst with a short
 *    timeout: fresh when the server is quick, the last copy (stamped, so the
 *    page can say how old it is) when it is not, /offline.html when there is
 *    none. Fragments are keyed apart from pages. Navigations use the
 *    navigation preload response, so the request is already on the wire
 *    while a cold worker boots.
 *  - The page cache holds one account's pages (src/web/page-cache.ts): it is
 *    dropped when a session starts or ends here, and when a page rendered
 *    for another account arrives. Every drop starts a new generation, and an
 *    answer to a request started in an older one is never stored.
 *  - Versioned scripts and styles are StaleWhileRevalidate; garment images
 *    are CacheFirst so recently viewed items render offline.
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

const DAY = 60 * 60 * 24;
const FALLBACK_HTML_URL = '/offline.html';
// v2 since 2026-09-26: copies are stamped and owned (pageStore below);
// pages-v1 held neither and is retired on activate.
const PAGES_CACHE = 'pages-v2';

// Static URLs carry `?v=<build>` (src/web/layout/layout.tsx); the precache is already keyed
// by content hash, so the query must not stop a precached file matching.
precacheAndRoute(self.__WB_MANIFEST, {
  ignoreURLParametersMatching: [/^utm_/, /^fbclid$/, /^v$/],
});

// Bookkeeping kept inside the pages cache, so dropping the cache drops it
// too. Off-origin keys: no page request can ever match one.
const OWNER_KEY = 'https://page-cache.invalid/owner';
const ACTIVATED_AT_KEY = 'https://page-cache.invalid/activated-at';

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

interface ServedFromCache {
  cachedAt: number;
  /** A tab root's revalidation; NetworkFirst fallbacks have none. */
  revalidation?: Promise<RevalidationResult>;
}

// The documents this worker answered from its cache, for the page's
// question (PAGE_FRESHNESS below), keyed by the document each navigation
// creates (servedKey): two tabs opening the same tab root each get their own
// answer. A page asks as soon as its script runs, so a short list is plenty;
// a document the network answered has no entry and is told it is fresh.
// htmx requests read the stamp from their own response instead.
const SERVED_PAGES_KEPT = 20;
const servedPages = new Map<string, ServedFromCache>();

/**
 * The key a navigation's answer is noted under: the id of the client
 * (document) it creates, which is the client its PAGE_FRESHNESS comes from.
 * A browser without FetchEvent.resultingClientId gets the URL, and with it
 * the old limit: two tabs opening one URL at the same moment share an entry.
 */
function servedKey(event: ExtendableEvent, url: string): string {
  return (event instanceof FetchEvent && event.resultingClientId) || url;
}

function noteServed(key: string, served: ServedFromCache | undefined): void {
  servedPages.delete(key);
  if (!served) return;
  servedPages.set(key, served);
  const oldest = servedPages.keys().next().value;
  if (servedPages.size > SERVED_PAGES_KEPT && oldest !== undefined) {
    servedPages.delete(oldest);
  }
}

/** A document's entry, removed: each document's question is answered once. */
function takeServed(
  clientId: string | undefined,
  url: string,
): ServedFromCache | undefined {
  const key =
    clientId !== undefined && servedPages.has(clientId) ? clientId : url;
  const served = servedPages.get(key);
  servedPages.delete(key);
  return served;
}

/**
 * The page cache's generation (#121). Every drop starts a new one; a page
 * request records the one it started in (pageStore's handlerWillStart), and
 * its answer is stored, or claims the cache, only while that generation is
 * still current. So a slow answer rendered for the account before a
 * sign-out, a sign-in or an account switch never lands in the next session's
 * cache. In memory on purpose: a stopped worker takes its in-flight requests
 * with it, so a new one has nothing older to refuse.
 */
let generation = 0;

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
 * Empties the page cache, whoever's pages it held, and warms the offline
 * page again for whoever is signed in now (it is a rendered view, with the
 * signed-in chrome). The new generation starts at once, before the drop
 * waits its turn: a request that starts from here on is the new session's.
 */
function dropPages(event: ExtendableEvent, reason: string): Promise<void> {
  generation += 1;
  return serialized(() => emptyPageCache(event, reason));
}

/** Holds the ownership lock; the caller has started the new generation. */
async function emptyPageCache(
  event: ExtendableEvent,
  reason: string,
): Promise<void> {
  // servedPages stays: a page served a moment ago may not have asked yet,
  // and its answer (the revalidation) is what makes it reload.
  await self.caches.delete(PAGES_CACHE);
  console.info(
    `[sw] ${reason}: cached pages dropped (generation ${generation})`,
  );
  event.waitUntil(rewarmOfflinePage(event));
}

async function rewarmOfflinePage(event: ExtendableEvent): Promise<void> {
  try {
    await Promise.all(
      pages.handleAll({ event, request: new Request(FALLBACK_HTML_URL) }),
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
    if (since !== generation) {
      console.info(
        `[sw] ${path} answered from generation ${since}, now ${generation}: not stored`,
      );
      return false;
    }
    const owner = await readRecord(OWNER_KEY);
    if (owner === account) return true;
    if (owner !== undefined) {
      // This answer is the new session's first word and keeps its place;
      // every other request of the old generation is refused.
      generation += 1;
      await emptyPageCache(
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

// Every page either strategy stores, after the 200 filter: answering a
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
// Workbox keeps per plugin and request; a StrategyHandler built by hand
// (revalidateForPage) must run handlerWillStart itself.
const pageStore: WorkboxPlugin = {
  handlerWillStart: async ({ state }) => {
    if (state) state.generation = generation;
  },
  cacheWillUpdate: async ({ request, response, event, state }) => {
    const since = Number(state?.generation ?? -1);
    const path = new URL(request.url).pathname;
    if (response.redirected) {
      if (sentToLogin(response)) await claimPageCache('', since, path, event);
      return null;
    }
    const claimed = await claimPageCache(
      pageAccount(response.headers),
      since,
      path,
      event,
    );
    if (!claimed) return null;
    return copyResponse(response, (init) => {
      const headers = new Headers(init.headers);
      headers.set(CACHED_AT_HEADER, String(Date.now()));
      return { ...init, headers };
    });
  },
};

// A copy is only read back for the account that owns the cache. Workbox
// writes an answer after cacheWillUpdate has claimed for it, so a drop can
// still fall between the two: the copy then lands in the emptied cache,
// rendered for an account that no longer (or not yet) owns it, and this is
// what keeps it from ever being served.
const ownedCopies: WorkboxPlugin = {
  cachedResponseWillBeUsed: async ({ request, cachedResponse }) =>
    cachedResponse &&
    (await isOwned(cachedResponse, new URL(request.url).pathname))
      ? cachedResponse
      : null,
};

async function isOwned(copy: Response, path: string): Promise<boolean> {
  const owner = await readRecord(OWNER_KEY);
  if (pageAccount(copy.headers) === owner) return true;
  console.warn(`[sw] ${path}: cached for another account, not served`);
  return false;
}

// A document NetworkFirst answered from its cache (the network timed out or
// failed) is noted for the page's question; one from the network clears the
// note.
const noteNavigations: WorkboxPlugin = {
  handlerWillRespond: async ({ request, response, event }) => {
    if (request.mode === 'navigate') {
      const stamp = cachedAt(response.headers);
      noteServed(
        servedKey(event, request.url),
        stamp ? { cachedAt: stamp } : undefined,
      );
    }
    return response;
  },
};

// Shared by both page strategies, which share the cache: the key rule (a
// fragment `|hx` never answers a page and the other way round), the store
// and read rules and one expiration.
const pagePlugins: WorkboxPlugin[] = [
  {
    cacheKeyWillBeUsed: async ({ request }) =>
      pageCacheKey(request.url, request.headers),
  },
  new CacheableResponsePlugin({ statuses: [200] }),
  pageStore,
  ownedCopies,
  new ExpirationPlugin({ maxEntries: 50, purgeOnQuotaError: true }),
];

const pages = new NetworkFirst({
  cacheName: PAGES_CACHE,
  networkTimeoutSeconds: 3,
  plugins: [...pagePlugins, noteNavigations],
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
    await dropPages(handler.event, `${path} revalidated ${outcome}`);
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
 * copy at once and the server's behind it, through the navigation preload.
 * Without a copy it is NetworkFirst. So is a copy stored before this worker
 * activated, once deleted: an older build rendered it, and its <head> (the
 * importmap, the asset URLs) must not meet this build's precached scripts,
 * not even as NetworkFirst's answer when the network is slow or gone (the
 * offline page answers then).
 */
class StaleTabRoot extends Strategy {
  protected async _handle(
    request: Request,
    handler: StrategyHandler,
  ): Promise<Response> {
    const cached = await handler.cacheMatch(request);
    if (!cached) return pages.handle({ event: handler.event, request });
    const stamp = cachedAt(cached.headers);
    const activatedAt = Number((await readRecord(ACTIVATED_AT_KEY)) ?? 0);
    const path = new URL(request.url).pathname;
    if (stamp <= activatedAt) {
      const cache = await self.caches.open(PAGES_CACHE);
      await cache.delete(pageCacheKey(request.url, request.headers));
      console.info(`[sw] ${path}: copy from before activation deleted`);
      return pages.handle({ event: handler.event, request });
    }
    const revalidation = revalidate(handler, request, cached.clone());
    void handler.waitUntil(revalidation);
    noteServed(servedKey(handler.event, request.url), {
      cachedAt: stamp,
      revalidation,
    });
    const ageSeconds = Math.round((Date.now() - stamp) / 1000);
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
// /auth/delete-account) change whose pages this device may show: once the
// server has answered, the cached pages go, so no session is ever served the
// previous one's, online or off. The server also sends Clear-Site-Data:
// "cache" whenever a session ends, which not every browser applies to Cache
// Storage. Registered before the page routes: the first match wins.
const SESSION_STARTS = new Set(['/auth/login', '/auth/register']);
const SESSION_ENDS = new Set(['/auth/logout', '/auth/delete-account']);

const isSessionBoundary = ({ url }: { url: URL }) =>
  url.origin === self.location.origin &&
  (SESSION_STARTS.has(url.pathname) || SESSION_ENDS.has(url.pathname));

type SessionChange = 'session started' | 'session ended' | 'session revoked';

/**
 * What an auth POST's answer did to this device's session. A redirect means
 * it changed (a navigation sees an opaque redirect, whose headers it cannot
 * read; htmx's XHR a followed one). A refusal (a wrong password, a taken
 * email) re-renders the form with a 4xx and changes nothing, unless it
 * says X-Session-Ended (endedSession): the cookie it was sent with no
 * longer opened a session (revoked elsewhere, expired), and the server
 * cleared it on this very answer (#131). The login form stays open to a
 * signed-in user, so this is a wrong password typed after the account's
 * password changed on another device.
 *
 * A sign-in keeps the push subscription even when its redirect also ended
 * a dead session (X-Session-Ended beside the new cookie): the auth forms
 * are native posts, so the worker sees an opaque redirect whose headers it
 * cannot read, and it need not. The next signed-in page re-sends the
 * subscription (syncSubscription, public/js/push.js), which moves the
 * device's row to the new account with its reminders off (upsertDevice,
 * src/web/push/queries.ts), so the previous account's notifications stop.
 */
function sessionChange(url: URL, response: Response): SessionChange | null {
  if (response.type === 'opaqueredirect' || response.redirected) {
    return SESSION_ENDS.has(url.pathname) ? 'session ended' : 'session started';
  }
  return endedSession(response.headers) ? 'session revoked' : null;
}

const sessionBoundaryHandler = async ({
  request,
  url,
  event,
}: RouteHandlerCallbackOptions) => {
  const response = await fetch(request);
  const change = sessionChange(url, response);
  // Dropped before answering, so the redirect's next page cannot race it.
  if (change) {
    await dropPages(event, change);
    if (change !== 'session started') {
      event.waitUntil(dropPushSubscription());
    }
  }
  return response;
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

// Garment photos: src/web/files/routes.ts serves them immutable under a versioned
// URL, so cached bytes are never stale. Only <img> loads are cached, so a
// watermark preview fetched by a share scraper never fills the quota.
registerRoute(
  ({ url, request }) =>
    url.pathname.startsWith('/file/') && request.destination === 'image',
  new CacheFirst({
    cacheName: 'images-v1',
    plugins: [
      new CacheableResponsePlugin({ statuses: [200] }),
      new ExpirationPlugin({
        maxEntries: 500,
        maxAgeSeconds: 30 * DAY,
        purgeOnQuotaError: true,
      }),
    ],
  }),
);

// Caches nothing reads any more: the in-browser background-removal model's
// (its runtime and ~42 MB of model and WASM, filled by workers before
// 2026-09-26, when the server took over background removal), and pages-v1
// (unstamped, unowned pages; see PAGES_CACHE).
const RETIRED_CACHES = [
  'bg-removal-models',
  'bg-removal-models-v2',
  'bg-removal-runtime-modules-v1',
  'pages-v1',
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
warmStrategyCache({ urls: [FALLBACK_HTML_URL], strategy: pages });

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

/**
 * PAGE_FRESHNESS: a document asks how it was served. Answers `fresh`, or
 * `cached` with the stamp and then, for a tab root, `revalidated` with the
 * outcome (and the server's page when it differs).
 */
async function answerFreshness(
  clientId: string | undefined,
  url: string,
  port: MessagePort,
): Promise<void> {
  const served = takeServed(clientId, url);
  if (!served) {
    port.postMessage({ state: 'fresh' });
    return;
  }
  port.postMessage({
    state: 'cached',
    cachedAt: served.cachedAt,
    revalidating: served.revalidation !== undefined,
  });
  if (served.revalidation) {
    port.postMessage({ state: 'revalidated', ...(await served.revalidation) });
  }
}

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

// Update flow: pwa.js shows a toast when a new worker is waiting and sends
// SKIP_WAITING when the user taps Reload. No skipWaiting() on install: a
// worker that seizes control mid-session leaves pages holding stale asset
// URLs, which is the black-screen bug the old hard-navigate hack papered over.
// The page questions come from public/js/freshness.js, each with a
// MessagePort for the answers.
self.addEventListener('message', (event) => {
  const type: unknown = event.data?.type;
  const [port] = event.ports;
  if (type === 'SKIP_WAITING') {
    console.log('[sw] SKIP_WAITING received');
    void self.skipWaiting();
  } else if (type === 'PAGE_FRESHNESS' && port) {
    const clientId =
      event.source instanceof Client ? event.source.id : undefined;
    event.waitUntil(answerFreshness(clientId, String(event.data.url), port));
  } else if (type === 'REVALIDATE_PAGE' && port) {
    event.waitUntil(
      revalidateForPage(
        event,
        String(event.data.url),
        event.data.fragment === true,
        port,
      ),
    );
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
// (notificationTarget).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data: unknown = event.notification.data;
  const url =
    typeof data === 'object' && data !== null && 'url' in data
      ? String(data.url)
      : '/';
  event.waitUntil(openWindow(notificationTarget(url, self.location.origin)));
});

async function openWindow(url: string): Promise<void> {
  // Controlled windows only (clientsClaim makes that every open page):
  // navigate() is refused for the others.
  const windows = await self.clients.matchAll({ type: 'window' });
  const showing = windows.find((client) => client.url === url);
  if (showing) {
    await showing.focus();
    return;
  }
  const [open] = windows;
  if (open) {
    const focused = await open.focus();
    // Null when the browser declines to navigate it (older WebKit): open a
    // window instead.
    if (await focused.navigate(url)) return;
  }
  await self.clients.openWindow(url);
}
