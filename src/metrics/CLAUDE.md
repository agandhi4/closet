# Metrics

Prometheus metrics for the homelab's VictoriaMetrics (#115, homelab #39): vmagent scrapes `GET /metrics` over the Docker network and Grafana's dashboards (in the homelab repo) read them. No analytics service, no third-party script: the data stays on the homelab.

## Layout

```
  metrics/             metrics.ts (Metrics: the per-app prom-client Registry and every metric; the label
                       vocabularies JobName, JobOutcome, CLIENT_TIMING_KINDS, CLIENT_TIMING_METRICS),
                       http.ts (registerHttpMetrics: the root hooks for the request histogram, the route
                       templates and Server-Timing), request-timing.ts (RequestTiming in async context:
                       the db and render parts of Server-Timing)
  web/metrics/         routes.ts: GET /metrics and POST /metrics/vitals, registered only with METRICS_ENABLED
public/js/vitals.js    the device's timings, loaded by the layout on signed-in pages with METRICS_ENABLED
```

## What is exported

| Metric | Labels | Recorded by |
| --- | --- | --- |
| `http_request_duration_seconds` (histogram) | `route` (the route template; `unmatched` for a 404 no route matched), `method`, `status_class` (`2xx`) | `registerHttpMetrics`' onResponse hook, every request |
| `job_duration_seconds` (histogram) | `name` (`JobName`: reconciliation, cutout, cutout_retry, reminders, reminder_prune, replan, replan_prune), `outcome` (ok, error; a cutout also discarded, interrupted) | `metrics.timeJob` around every timer's run in `server.ts`; `CutoutQueue` per photo |
| `cutout_queue_depth` (gauge) | none | a count of pending cutouts, read at each scrape |
| `push_sends_total` | `outcome` (delivered, pruned, failed) | the Web Push sender, per device |
| `mcp_tool_call_duration_seconds` (histogram) | `tool`, `outcome` (ok, refused, error) | `registerTools` (`src/web/mcp/tool.ts`) |
| `client_timing_seconds` (histogram) | `route`, `kind` (full, htmx, restore), `metric` (ttfb, lcp, inp, request, settle), `cache` (hit, miss: the service worker's page cache) | `POST /metrics/vitals` |
| `client_timing_dropped_total` | `reason` (unknown_route) | the same, for a sample naming no route of the app |

Plus prom-client's default process metrics (CPU, memory, event loop lag, GC) with METRICS_ENABLED.

**The homelab contract** (the owner's, 2026-09-27): the first two names and their labels are what the RED dashboard reads; **no metric has a `job` label** (the scraper sets it; `metrics.spec.ts` checks). `route` is always a template (`/wardrobe/:id`), so cardinality is bounded by the route table.

## The device timings

`public/js/vitals.js` (a module in the head, so it never blocks rendering and runs once per document; about 1.5 KB with brotli) measures, per route template:

- **full**: a document load's TTFB (Navigation Timing, `responseStart`) and LCP, and whether the service worker answered from its page cache (freshness.js's `#freshness` stamp older than the navigation);
- **htmx**: every htmx request, `request` (`htmx:beforeRequest` to `afterRequest`) and `settle` (to `afterSettle`), with `cache` from the answer's `X-SW-Cached-At`: boosted taps, Styling's Shuffle and rows, the calendar's week and month links, the plan sheet's choices, fragments such as the weather line;
- **restore**: an htmx history restore, `popstate` to `htmx:historyRestore`;
- **inp**: the slowest interaction (Event Timing, 40 ms and over) while a page was on screen, sent with it when it leaves or the tab hides (the plan sheet opening, swipes and taps on Styling). Safari has no Event Timing: no INP from iPhones.

**The route comes from the server**: every answer carries `Server-Timing: db;dur=..., render;dur=..., route;desc="/calendar"`. A full load reads it from Navigation Timing's `serverTiming` (a copy from the service worker keeps the header), an htmx request from the response header; a history restore uses the route last seen at that path. So no URL, id or query string ever leaves the device, and the server still accepts only a route it has (`Metrics.addRoute`, from an `onRoute` hook): anything else is dropped and counted.

Batches of up to 20 go out with `navigator.sendBeacon` 5 s after their first sample and whenever the page hides, as a `text/plain` string (a simple request everywhere; a JSON Blob is refused by some browsers). `POST /metrics/vitals` reads text/plain as JSON in its own plugin, and refuses: no session (the gate's 401/302), a body over 8 KB (413, before it is read), a batch that fails the schema (400: more than 20 samples, an unknown kind, a time below 0 or over 60 s), more than 30 batches a minute per user (`VITALS_LIMIT`, 429). vitals.js drops a time over 60 s itself, so one backgrounded tab never costs the batch.

## Server-Timing

`db` is the time the request's queries held a pool connection, the wait for one included (`TimedPool`, `src/db/client.ts`: `connect()` reads the request's timing in the caller's async context, the pool's `release` event adds the time; concurrent queries add up), `render` the time in `renderToString` (`renderPage`/`renderFragment`, `src/web/render.ts`). The timing lives in `AsyncLocalStorage`, entered by the first root onRequest hook and again at the first preValidation hook (a body parser's stream events run in the socket's context, so a POST's handler would otherwise have none). Outside a request (timers, CLIs) nothing is recorded.

## Gotchas

- **`/metrics` must never be public.** Caddy proxies every path of closet.box to the container, so the route answers only a direct request: one with `X-Forwarded-For` or `Forwarded` (Caddy and Pangolin add them) is a 404 with a warning (context `Web`). It is a static path (`static-prefixes.ts`), so a scrape costs no session lookup and writes no request line. Off (the default), the route does not exist: a 404, which is what the homelab's `expect_up` label turns into a TargetDown.
- **One registry per app, never prom-client's global one.** The integration specs boot many apps in one process; the global registry would refuse the second `http_request_duration_seconds`. Metrics are recorded with METRICS_ENABLED off too (a few additions a request); only exposure is gated.
- **A new label value must come from a closed set.** A route template, a `JobName`, a tool name, an outcome: never a URL, id, email or user agent. A new timer in `server.ts` wraps its run in `metrics.timeJob(<JobName>, run)`.
