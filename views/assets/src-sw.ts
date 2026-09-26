import { clientsClaim } from 'workbox-core';
import { precacheAndRoute } from 'workbox-precaching';
import { warmStrategyCache } from 'workbox-recipes';
import { registerRoute, setCatchHandler } from 'workbox-routing';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { ExpirationPlugin } from 'workbox-expiration';
import {
  CacheFirst,
  NetworkFirst,
  StaleWhileRevalidate,
} from 'workbox-strategies';
import { pageCacheKey } from '../../src/htmx/fragment-request';
import {
  notificationTarget,
  parsePushPayload,
  type PushPayload,
} from '../../src/web/push/payload';

/**
 * Caching model (public/js/pwa.js is the page side):
 *  - App shell files under public/ are precached by content hash
 *    (workbox-config.js), so a repeat visit paints from cache.
 *  - Pages and htmx fragments are NetworkFirst with a short timeout: fresh
 *    when the server is quick, the last copy when it is not, /offline.html
 *    when there is none. Fragments are keyed apart from pages.
 *  - Versioned scripts and styles are StaleWhileRevalidate; garment images
 *    are CacheFirst so recently viewed items render offline.
 *  - Anything unmatched (POSTs, /healthz) goes straight to the network.
 */

declare const self: ServiceWorkerGlobalScope;

// https://developer.chrome.com/docs/workbox/modules/workbox-core#clients_claim
// Top level on purpose: once the user accepts an update (SKIP_WAITING below)
// the new worker must take the open pages so `controlling` fires and
// pwa.js can reload.
clientsClaim();

const DAY = 60 * 60 * 24;
const FALLBACK_HTML_URL = '/offline.html';
const PAGES_CACHE = 'pages-v1';

// Static URLs carry `?v=<build>` (layout.hbs); the precache is already keyed
// by content hash, so the query must not stop a precached file matching.
precacheAndRoute(self.__WB_MANIFEST, {
  ignoreURLParametersMatching: [/^utm_/, /^fbclid$/, /^v$/],
});

// Pages and htmx fragments. The key plugin keeps a fragment (`|hx`) from
// ever answering a navigation for the same URL, and the other way round.
const pages = new NetworkFirst({
  cacheName: PAGES_CACHE,
  networkTimeoutSeconds: 3,
  plugins: [
    {
      cacheKeyWillBeUsed: async ({ request }) =>
        pageCacheKey(request.url, request.headers),
    },
    new CacheableResponsePlugin({ statuses: [200] }),
    new ExpirationPlugin({ maxEntries: 50, purgeOnQuotaError: true }),
  ],
});
const isPageRequest = ({ request }: { request: Request }) =>
  request.mode === 'navigate' || request.headers.get('HX-Request') === 'true';

// Signing out (GET /auth/logout) and deleting the account (POST
// /auth/delete-account) end a session: once the server has answered with
// its redirect, the pages cached for that user must not answer the next
// person on this device, offline or on a slow network. The server also
// sends Clear-Site-Data: "cache", which not every browser applies to Cache
// Storage. The offline page is re-warmed, now rendered signed out.
// Registered before the page route: the first matching route wins.
const SESSION_ENDING_PATHS = new Set(['/auth/logout', '/auth/delete-account']);

async function rewarmOfflinePage(): Promise<void> {
  try {
    const cache = await self.caches.open(PAGES_CACHE);
    await cache.add(FALLBACK_HTML_URL);
  } catch (error) {
    console.warn('[sw] could not re-warm the offline page', error);
  }
}

const endsSession = ({ url }: { url: URL }) =>
  url.origin === self.location.origin && SESSION_ENDING_PATHS.has(url.pathname);

const endSessionHandler = async ({
  request,
  event,
}: {
  request: Request;
  event: ExtendableEvent;
}) => {
  const response = await fetch(request);
  // A redirect means the session ended (a navigation sees it as an opaque
  // redirect, htmx's XHR as a followed one); a refused deletion is a 401 page.
  // Deleted before answering, so the redirect's next page cannot race it.
  if (response.type === 'opaqueredirect' || response.redirected) {
    console.info('[sw] session ended, dropping cached pages');
    await self.caches.delete(PAGES_CACHE);
    event.waitUntil(rewarmOfflinePage());
    event.waitUntil(dropPushSubscription());
  }
  return response;
};

// A signed-out device receives nobody's notifications: the subscription goes
// with the session. The server's row is removed when its push service next
// answers 410 (src/web/push/sender.ts), or with the account. Signing in
// again, the profile page offers to enable them (no new prompt: the
// permission stays).
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

registerRoute(endsSession, endSessionHandler, 'GET');
registerRoute(endsSession, endSessionHandler, 'POST');

registerRoute(isPageRequest, pages);

// First-party scripts and styles are `?v=`-versioned and served immutable by
// app.ts, so serving the cached copy while refreshing is safe. The
// background-removal runtime is excluded: it loads its own chunks and
// resources.json by relative, unversioned URLs and needs the rule below.
registerRoute(
  ({ url, request }) =>
    url.origin === self.location.origin &&
    (url.pathname === '/bundle.css' ||
      url.pathname.startsWith('/js/') ||
      (url.pathname.startsWith('/modules/') &&
        !url.pathname.startsWith('/modules/onnxruntime-web/') &&
        !url.pathname.startsWith('/modules/background-removal/'))) &&
    request.method === 'GET',
  new StaleWhileRevalidate({
    cacheName: 'assets-v1',
    plugins: [
      new CacheableResponsePlugin({ statuses: [200] }),
      new ExpirationPlugin({ maxEntries: 60, purgeOnQuotaError: true }),
    ],
  }),
);

// Garment photos: FileController serves them immutable under a versioned
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

// Background-removal model resources include a stable resources.json URL.
// NetworkFirst avoids stale metadata/chunk mismatches after deploys; the
// fetch bypasses the year-long HTTP cache (app.ts) so the revalidation is
// real, and the server's ETag keeps it a 304.
registerRoute(
  ({ url }) => url.pathname.startsWith('/bg-removal-models/'),
  new NetworkFirst({
    cacheName: 'bg-removal-models-v2',
    fetchOptions: { cache: 'no-cache' },
    plugins: [
      new CacheableResponsePlugin({ statuses: [200] }),
      new ExpirationPlugin({
        maxEntries: 200,
        maxAgeSeconds: 30 * DAY,
        purgeOnQuotaError: true,
      }),
    ],
  }),
);

// Keep ORT and background-removal runtime modules fresh so JS/WASM assets don't drift.
registerRoute(
  ({ url }) =>
    url.pathname.startsWith('/modules/onnxruntime-web/') ||
    url.pathname.startsWith('/modules/background-removal/'),
  new NetworkFirst({
    cacheName: 'bg-removal-runtime-modules-v1',
    networkTimeoutSeconds: 3,
    fetchOptions: { cache: 'no-cache' },
    plugins: [
      new CacheableResponsePlugin({ statuses: [200] }),
      new ExpirationPlugin({
        maxEntries: 100,
        maxAgeSeconds: 7 * DAY,
        purgeOnQuotaError: true,
      }),
    ],
  }),
);

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
    if (fallback) return fallback;
  }
  return Response.error();
});

// Update flow: pwa.js shows a toast when a new worker is waiting and sends
// this message when the user taps Reload. No skipWaiting() on install: a
// worker that seizes control mid-session leaves pages holding stale asset
// URLs, which is the black-screen bug the old hard-navigate hack papered over.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    console.log('[sw] SKIP_WAITING received');
    void self.skipWaiting();
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
