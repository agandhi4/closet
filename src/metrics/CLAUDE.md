# Metrics

Prometheus metrics for the homelab's VictoriaMetrics (#115, homelab #39): vmagent scrapes `GET /metrics` over the Docker network and Grafana's dashboards (in the homelab repo) read them. No analytics service, no third-party script: the data stays on the homelab.

## Layout

```
  metrics/             metrics.ts (Metrics: the per-app `@prometheus-io/client` Registry and every metric; the label
                       vocabularies JobName, JobOutcome, CLIENT_TIMING_KINDS, CLIENT_TIMING_METRICS),
                       http.ts (registerHttpMetrics: the root hooks for the request histogram, the route
                       templates and Server-Timing), request-timing.ts (RequestTiming in async context:
                       the db and render parts of Server-Timing)
  web/metrics/         routes.ts: GET /metrics and POST /metrics/vitals, registered only with METRICS_ENABLED
public/js/vitals.js    the device's timings, loaded by the layout on signed-in pages with METRICS_ENABLED
```

## What is exported

| Metric                                       | Labels                                                                                                                                                                        | Recorded by                                                                        |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `http_request_duration_seconds` (histogram)  | `route` (the route template; `unmatched` for a 404 no route matched), `method`, `status_class` (`2xx`)                                                                        | `registerHttpMetrics`' onResponse hook, every request                              |
| `job_duration_seconds` (histogram)           | `name` (`JobName`: reconciliation, cutout, cutout_retry, reminders, reminder_prune, replan, replan_prune), `outcome` (success, failure; a cutout also discarded, interrupted) | `metrics.timeJob` around every timer's run in `server.ts`; `CutoutQueue` per photo |
| `cutout_queue_depth` (gauge)                 | none                                                                                                                                                                          | a count of pending cutouts, read at each scrape                                    |
| `push_sends_total`                           | `outcome` (delivered, pruned, failed)                                                                                                                                         | the Web Push sender, per device                                                    |
| `mcp_tool_call_duration_seconds` (histogram) | `tool`, `outcome` (ok, refused, error)                                                                                                                                        | `registerTools` (`src/web/mcp/tool.ts`)                                            |
| `client_timing_seconds` (histogram)          | `route`, `kind` (full, htmx, restore), `metric` (ttfb, lcp, inp, request, settle), `cache` (hit, miss: the service worker's page cache)                                       | `POST /metrics/vitals`                                                             |
| `client_timing_dropped_total`                | `reason` (unknown_route)                                                                                                                                                      | the same, for a sample naming no route of the app                                  |

Plus the client library's default process metrics (CPU, memory, event loop lag and utilization, GC) with METRICS_ENABLED.

**The homelab contract** (the owner's, 2026-09-27): the first two names and their labels are what the RED dashboard reads, and **a job's `outcome` is `success` or `failure`**, the values shared with finplat that the homelab's JobFailed alert and the dashboard select (`outcome="failure"`, `stacks/homeinfra/vmalert/rules/apps.yml` and its README, Metrics). Closet exported `ok`/`error` until #136, so JobFailed never fired for it. The other outcome labels (`push_sends_total`, `mcp_tool_call_duration_seconds`) are closet's own: no homelab rule or dashboard reads them. **No metric has a `job` label** (the scraper sets it; `metrics.spec.ts` checks). `route` is always a template (`/wardrobe/:id`), so cardinality is bounded by the route table. `metrics.spec.ts` holds the contract as an inline snapshot of every family's type, and every series' name and label names (with the `le` and job `outcome` values), recorded under prom-client and passed unchanged by `@prometheus-io/client` (#136); a change there is a change to the homelab's dashboards, made with them. The default process families are checked as a superset.

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

**A request that checked a secret answers without it** (#136). `db;dur` to a tenth of a millisecond is the server's own time without the network's jitter: whether an email's lookup found a row, whether a token matched. So every function that checks a secret a request carries calls `markSecretChecked()` (`request-timing.ts`) before it looks, and the onSend hook leaves the header off a marked request. The functions are `verifyPassword` (sign-in, and every step-up form: change password, change email, delete account, create an access token), `authenticateToken` (`/mcp`), and `findInvite`/`acceptInvite`/`declineInvite` (the invite routes). No route declares it, so a new credential route is covered as long as it checks through one of those; a new kind of secret check calls `markSecretChecked()` itself. The mark rides the request's async context like `db` time, so the query layer needs no request; the seed and the CLIs call the same functions outside a request, where it does nothing. Marked requests still land in `http_request_duration_seconds`; the device timings skip them (no `route` for vitals.js to name). `http.spec.ts` proves an unflagged test route that calls `verifyPassword` gets no header; `test/integration/metrics.spec.ts` covers the real routes. Not marked: registration (its refusal names the taken address anyway) and `/share` and `/file/watermark/:shareableId` (random link ids, where the page already says whether one exists).

## Gotchas

- **`/metrics` must never be public.** Caddy proxies every path of closet.box to the container, so the route answers only a direct request: one with `X-Forwarded-For` or `Forwarded` (Caddy and Pangolin add them) is a 404 with a warning (context `Web`). It is a static path (`static-prefixes.ts`), so a scrape costs no session lookup and writes no request line. Off (the default), the route does not exist: a 404, which is what the homelab's `expect_up` label turns into a TargetDown.
- **One registry per app, never the library's global one.** The integration specs boot many apps in one process; the global registry would refuse the second `http_request_duration_seconds`. Metrics are recorded with METRICS_ENABLED off too (a few additions a request); only exposure is gated.
- **`@prometheus-io/client` is prom-client renamed** (the Prometheus project took it over at 0.16; `prom-client@15` is deprecated). Same API; it needs Node 22 or later. Pre-1.0: read its changelog before a minor bump, and let the contract snapshot judge it.
- **A new label value must come from a closed set.** A route template, a `JobName`, a tool name, an outcome: never a URL, id, email or user agent. A new timer in `server.ts` wraps its run in `metrics.timeJob(<JobName>, run)`.
