// This device's timings for the homelab's metrics (#115): full loads (TTFB,
// LCP), htmx requests (sent to answered, answered to settled), history
// restores, and the slowest interaction (INP) while each page is on screen.
// Named by route template from the server's Server-Timing, never a URL, and
// beaconed in batches to POST /metrics/vitals (src/web/metrics/routes.ts).
const MAX = 20;
const queue = [];
const routes = {};
const requests = new WeakMap();
let timer = 0;
let popped = 0;
let view;

// freshness.js stamps a page the worker answered from its cache.
const fromCache = () =>
  Number(document.getElementById('freshness')?.dataset.fetchedAt) <
  performance.timeOrigin;
const routeIn = (xhr) =>
  /route;desc="([^"]*)"/.exec(xhr.getResponseHeader('Server-Timing'))?.[1];

function send() {
  clearTimeout(timer);
  timer = 0;
  if (queue.length) {
    const body = JSON.stringify({ samples: queue.splice(0, MAX) });
    navigator.sendBeacon('/metrics/vitals', body);
  }
}

function push(route, kind, cache, ms) {
  // The server refuses a batch with a value past a minute (a tab left
  // in the background, not a wait).
  for (const key in ms) {
    if (ms[key] >= 0 && ms[key] <= 60_000) ms[key] = Math.round(ms[key]);
    else delete ms[key];
  }
  if (!route || !Object.keys(ms).length) return;
  queue.push({ route, kind, cache, ms });
  if (queue.length >= MAX) send();
  else timer ||= setTimeout(send, 5_000);
}

// What a page measured while on screen is final once it leaves or hides.
function end() {
  const { route, kind, cache, ttfb, lcp, inp } = view;
  push(route, kind, cache, { ttfb, lcp, inp });
  view = { route, kind, cache, path: view.path };
}

function show(route, kind, cache) {
  if (view) end();
  view = { route, kind, cache, path: location.pathname };
  routes[view.path] = route;
}

const nav = performance.getEntriesByType('navigation')[0];
show(
  nav?.serverTiming?.find((entry) => entry.name === 'route')?.description,
  'full',
  false,
);
if (nav) view.ttfb = nav.responseStart - (nav.activationStart ?? 0);
const full = view;

function observe(type, record, options) {
  try {
    new PerformanceObserver((list) =>
      list.getEntries().forEach(record),
    ).observe({ type, buffered: true, ...options });
  } catch {
    // Not in this browser (Safari has no event timing).
  }
}
observe('largest-contentful-paint', (entry) => {
  if (view === full) view.lcp = entry.startTime;
});
observe(
  'event',
  (entry) => {
    if (entry.interactionId) view.inp = Math.max(view.inp ?? 0, entry.duration);
  },
  { durationThreshold: 40 },
);

document.addEventListener('htmx:beforeRequest', (event) => {
  // Read before a swap replaces the load's #freshness.
  if (view === full) full.cache = fromCache();
  requests.set(event.detail.xhr, [performance.now()]);
});
document.addEventListener('htmx:afterRequest', (event) => {
  requests.get(event.detail.xhr)?.push(performance.now());
});
document.addEventListener('htmx:afterSettle', (event) => {
  const { xhr } = event.detail;
  const [sent, answered] = requests.get(xhr) ?? [];
  if (answered === undefined) return;
  requests.delete(xhr);
  const route = routeIn(xhr);
  const cache = !!xhr.getResponseHeader('X-SW-Cached-At');
  const settled = performance.now();
  push(route, 'htmx', cache, {
    request: answered - sent,
    settle: settled - answered,
  });
  // A boosted link or a pushed URL: another page is on screen.
  if (location.pathname !== view.path) show(route, 'htmx', cache);
});

addEventListener('popstate', () => (popped = performance.now()), true);
document.addEventListener('htmx:historyCacheMissLoad', (event) => {
  routes[event.detail.path.split('?')[0]] = routeIn(event.detail.xhr);
});
document.addEventListener('htmx:historyRestore', () => {
  const route = routes[location.pathname];
  if (popped)
    push(route, 'restore', false, { settle: performance.now() - popped });
  popped = 0;
  show(route, 'restore', false);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (view === full) full.cache = fromCache();
    end();
    send();
  }
});
