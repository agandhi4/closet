// This page's uncaught errors and unhandled promise rejections, for the
// homelab's Bugsink (#117): beaconed to POST /errors/client
// (src/web/metrics/client-errors.ts), which forwards them. Loaded by the
// layout only with SENTRY_DSN, on signed-in pages, as the first deferred
// script (a classic one: document.currentScript carries data-release).
// A distinct error is sent once per document and a page view sends at most
// MAX_PER_PAGE; the server rate-limits what is left. Named by the route
// template from the server's Server-Timing, never a URL.
(() => {
  const MAX_PER_PAGE = 5;
  // The server's limits (client-errors.ts).
  const MAX_MESSAGE = 1000;
  const MAX_STACK = 8000;
  const release = document.currentScript?.dataset.release;
  const seen = new Set();
  const routes = {};
  let page = location.pathname;
  let sent = 0;

  const routeIn = (header) => /route;desc="([^"]*)"/.exec(header ?? '')?.[1];
  routes[page] = performance
    .getEntriesByType('navigation')[0]
    ?.serverTiming?.find((entry) => entry.name === 'route')?.description;

  // A boosted link or a pushed URL put another page on screen: its route
  // came with the answer that brought it, and it gets its own allowance.
  document.addEventListener('htmx:afterSettle', (event) => {
    if (location.pathname === page) return;
    page = location.pathname;
    sent = 0;
    routes[page] ??= routeIn(
      event.detail.xhr?.getResponseHeader('Server-Timing'),
    );
  });
  document.addEventListener('htmx:historyCacheMissLoad', (event) => {
    routes[event.detail.path.split('?')[0]] = routeIn(
      event.detail.xhr.getResponseHeader('Server-Timing'),
    );
  });
  document.addEventListener('htmx:historyRestore', () => {
    page = location.pathname;
    sent = 0;
  });

  function report(error, fallback) {
    const message = String(
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : (fallback ?? error),
    ).slice(0, MAX_MESSAGE);
    const stack =
      error instanceof Error && typeof error.stack === 'string'
        ? error.stack.slice(0, MAX_STACK)
        : undefined;
    const key = `${message}\n${stack ?? ''}`;
    if (!message || seen.has(key) || sent >= MAX_PER_PAGE) return;
    seen.add(key);
    sent += 1;
    navigator.sendBeacon(
      '/errors/client',
      JSON.stringify({ message, stack, route: routes[page], release }),
    );
  }

  addEventListener('error', (event) => report(event.error, event.message));
  addEventListener('unhandledrejection', (event) =>
    report(event.reason, `Unhandled rejection: ${String(event.reason)}`),
  );
})();
