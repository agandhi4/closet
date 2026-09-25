import { clientsClaim } from 'workbox-core';
import { precacheAndRoute } from 'workbox-precaching';
import { warmStrategyCache } from 'workbox-recipes';
import { registerRoute, setCatchHandler } from 'workbox-routing';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { ExpirationPlugin } from 'workbox-expiration';
import {
  CacheFirst,
  NetworkFirst,
  NetworkOnly,
  StaleWhileRevalidate,
} from 'workbox-strategies';
import { pageCacheKey } from '../../src/htmx/fragment-request';

/**
 * Caching model (public/js/pwa.js is the page side):
 *  - App shell files under public/ are precached by content hash
 *    (workbox-config.js), so a repeat visit paints from cache.
 *  - Pages and htmx fragments are NetworkFirst with a short timeout: fresh
 *    when the server is quick, the last copy when it is not, /offline.html
 *    when there is none. Fragments are keyed apart from pages.
 *  - Versioned scripts and styles are StaleWhileRevalidate; garment images
 *    are CacheFirst so recently viewed items render offline.
 *  - Anything unmatched (POSTs, /healthz, /sse) goes straight to the network.
 */

declare const self: ServiceWorkerGlobalScope;

// https://developer.chrome.com/docs/workbox/modules/workbox-core#clients_claim
// Top level on purpose: once the user accepts an update (SKIP_WAITING below)
// the new worker must take the open pages so `controlling` fires and
// pwa.js can reload.
clientsClaim();

const DAY = 60 * 60 * 24;
const FALLBACK_HTML_URL = '/offline.html';

// Static URLs carry `?v=<build>` (layout.hbs); the precache is already keyed
// by content hash, so the query must not stop a precached file matching.
precacheAndRoute(self.__WB_MANIFEST, {
  ignoreURLParametersMatching: [/^utm_/, /^fbclid$/, /^v$/],
});

// Pages and htmx fragments. The key plugin keeps a fragment (`|hx`) from
// ever answering a navigation for the same URL, and the other way round.
const pages = new NetworkFirst({
  cacheName: 'pages-v1',
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

// Streaming; never cache, never time out.
registerRoute(({ url }) => url.pathname === '/sse', new NetworkOnly());

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
// URL, so cached bytes are never stale. request.destination guards against
// /file/files and /file/upload, which are pages under the same prefix.
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
    request.mode === 'navigate' ||
    request.headers.get('HX-Boosted') === 'true';
  if (wantsPage) {
    const cache = await self.caches.open('pages-v1');
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

// Web Push Notification Handling
// https://blog.lekoala.be/the-only-snippet-you-will-need-to-deal-with-push-notifications-in-a-service-worker
// @link https://flaviocopes.com/push-api/
// @link https://web.dev/push-notifications-handling-messages/
self.addEventListener('push', function (event) {
  if (!event.data) {
    console.log('This push event has no data.');
    return;
  }
  if (!self.registration || !self.registration.pushManager) {
    console.log('Push is not supported');
    return;
  }

  const eventText = event.data.text();
  // Specify default options
  let options = {};
  let title = '';

  // Support both plain text notification and json
  if (eventText.substr(0, 1) === '{') {
    const eventData = JSON.parse(eventText);
    title = eventData.title;

    // Set specific options
    // @link https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification#parameters
    if (eventData.options) {
      options = Object.assign(options, eventData.options);
    }

    // Check expiration if specified
    if (eventData.expires && Date.now() > eventData.expires) {
      console.log('Push notification has expired');
      return;
    }
  } else {
    title = eventText;
  }

  // Warning: this can fail silently if notifications are disabled at system level
  // The promise itself resolve to undefined and is not helpful to see if it has been displayed properly
  const promiseChain = self.registration.showNotification(title, options);

  // With this, the browser will keep the service worker running until the promise you passed in has settled.
  event.waitUntil(promiseChain);
});
