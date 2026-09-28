# Page performance

`npm run audit:pages` (#157) measures every page, fragment, action, MCP tool
and background job the page audits name (#158 to #174, epic #156), as the
demo persona, on the production build. `baseline.md` and `baseline.json` in
this directory are that run on `main` (last regenerated 2026-09-28 at
`3c9aa94`, after merging main's photo rotate and garment page changes, load
average 7.9 rising to 25.4 as other agents' runs started: times from it are
rough, counts exact); every page PR shows its before and after against them.

## What it does

1. Builds (`npm run build`), then boots `dist/` **in process** with
   `createApp`, the way the integration harness boots `src/`, with
   production's flags (`NODE_ENV=production`, PWA, weather, metrics,
   error tracking and the order mail on) on a throwaway database on the shared local Postgres
   (`TEST_DATABASE_URL`, default pgvault-dev on :5432) and a temporary
   `DATA_PATH`. The database is dropped at the end, whatever happened.
2. Seeds Theo (`demo`) and Dana (`sparse`, who shares her wardrobe with
   Theo) through the seed, anchored on today, runs `ANALYZE` (a production
   database has planner statistics; a fresh one guesses), and signs in as
   Theo.
3. Walks `scripts/audit/steps.ts`: pages over the seed as it is, then the
   writes, the MCP tools and the jobs. Each step runs 3 times untimed, then
   20 times timed (fewer where a rate limit allows only so many a minute:
   the step says so). A write that needs something to act on (a garment to
   delete, a fresh account to change the password of) makes it first,
   unmeasured.
4. Writes `scripts/results/audit.md` (a table per audit issue) and
   `audit.json` (the numbers, and each step's SQL, for a later diff), plus
   `scripts/results/audit.app.log`, the app's own log of the run (always
   under `scripts/results/`, whatever `--out` says).

Per step it records:

| Column | What |
| --- | --- |
| p50 ms, p95 ms | Wall time of the request in process (`app.inject`: routing, hooks, handler, render, compression; no network), or of the job's run |
| db ms | Server-Timing's `db` (connection time; concurrent queries add up, so it can exceed the total). Empty where the answer has none: a checked password or token, a static path, a job |
| Statements, Rows | SQL statements the request sent and the rows they returned (the median run; a range when runs differed) |
| KB, Wire KB | The body as the browser reads it, and as sent with `Accept-Encoding: br, gzip` |

The report's last section, **Not walked**, lists route templates and MCP tools no step
requested. It is empty; a new route should keep it so by joining its audit
issue's group in `steps.ts`.

**How SQL is recorded**: `test/support/query-recorder.ts` wraps
node-postgres's `Client.prototype.query` in the audit's own process, only
while a step's request runs (the integration harness's `recordQueries` is
the same wrapper). Nothing is added to the app or its request path, and no
environment flag exists that could turn it on in production.

**The outside world** is the tests' stand-ins: Open-Meteo
(`test/support/weather-stub.ts`), a shop for the link import and the order
mail's links (`test/integration/link-sites.ts`,
`test/support/order-mail-shop.ts`), Fastmail's JMAP
(`test/support/jmap-stub.ts`: the fixture's `ORDER_MAIL_*` are stand-ins and
nothing reaches Fastmail), Bugsink (`test/support/sentry-stub.ts`), and
web-push's send, which answers in process. The order mail's owner is Theo:
"From your orders" starts with a seeded order of six items, written as the
poll writes them, and each run of the poll step reads one new copy of the
forwarded order email (`test/fixtures/order-mail/`). Background removal is an
instant stand-in held behind a gate that only the cutout step opens, so an
upload's cutout never runs while another step is measured.

## Using it on a page PR

```bash
(cd ../pgvault-dev && docker compose up -d --wait)
npm run audit:pages -- --only '#159' --compare docs/perf/baseline.json
```

- `--only TEXT` keeps the steps whose issue (`#159`), name or target contains
  TEXT; the rest are skipped (and the Not walked check with them).
- `--compare FILE` prints, and writes to `audit.compare.md`, every step whose
  statements, rows or bytes changed, and every time past the noise below,
  with the SQL each step gained or lost.
- `--explain` adds `audit.explain.md`: `EXPLAIN (ANALYZE, BUFFERS)` of each
  step's three slowest statements, each run in a transaction rolled back (a
  write's plan is measured and undone).
- `--runs N`, `--warmup N` (20 and 3), `--out PREFIX` (`scripts/results/audit`).

Put the comparison in the PR: the steps of the issue's scope, before and
after. Statements, rows and bytes are exact for a seed day, so any change is
real; a time is a change only past the noise.

**Refresh the baseline** in the PR that changes it (after merging `main`),
so the next PR compares against the new state:

```bash
npm run audit:pages -- --out docs/perf/baseline
```

## Noise

Measured on linux-box (Ryzen 7 8845HS, 16 threads, pgvault-dev on Postgres
18) on 2026-09-28, with two runs of the same build one after the other
(the baseline, then `--compare` against it), while other agents' test runs
shared the box (load average 5 to 15). The change of each step's p50 from
one run to the other, as a fraction of the first:

| Steps | n | Median change | 90th percentile | Median ms | 90th percentile ms |
| --- | --: | --: | --: | --: | --: |
| All | 274 | 19.0% | 35.4% | 0.73 | 2.48 |
| Pages | 81 | 22.5% | 32.2% | 1.51 | 2.42 |
| Fragments | 21 | 20.7% | 31.1% | 0.75 | 2.10 |
| Actions | 101 | 15.8% | 36.2% | 0.50 | 2.58 |
| MCP tools | 40 | 5.7% | 23.6% | 0.41 | 1.49 |
| Jobs | 11 | 29.5% | 57.0% | 0.29 | 3.87 |

The second run was faster on 186 steps and slower on 88: most of it is the
box getting quieter between the two, not per-step jitter. So a time counts
as changed only past 35% **and** 2 ms, both ways (`TIME_NOISE`,
`scripts/audit/report.ts`); between these two runs that flags 3 steps of
274. A first attempt with each step's runs back to back, not in rounds, on a
busier box (load average 16 to 24) disagreed by 29% at the median and 61% at
the 90th percentile: the reads now run in rounds (`Phase.interleave`,
`scripts/audit/walk.ts`), so a burst of load elsewhere lands on one sample of
many steps rather than on every sample of one.

Statements, rows and bytes did not move between the runs (the one exception
is `/metrics`, whose body grows as the run records), so any change in them is
real.

Things that make times noisier: another heavy process on the box (a build,
Playwright, another agent's tests, a second audit). The report's header says
the load average at the start and end of the walk; compare runs made under
similar load, from the same machine: CI's nightly run
(`.github/workflows/nightly.yml`) compares against this baseline too, but
its times are a different machine's; only its counts and bytes compare.

## What it does not measure

- The browser: layout, script execution, LCP and INP. The devices report
  those in production (`public/js/vitals.js`, `client_timing_seconds` in
  Grafana); the report's Wire KB is the transfer side of it.
- Concurrency and throughput: every request runs alone.
- The network: `inject` has no socket, so no TCP or TLS, and Caddy is not
  in the path.

## Gotchas

- **Rows and counts depend on the seed day.** The seed is anchored on
  today, so the planned week, Today's ideas and the calendar move with the
  date. Compare runs from the same day where a step's rows changed and
  nothing in the diff explains it.
- **Steps share Theo.** The writes run after the pages and change his
  wardrobe (a garment worn, a plan added), so a write's numbers are those of
  the state the steps before it left. Order matters: add a step to the end
  of its group.
- **A killed run leaves its scratch database** (`closet_audit_*`); Ctrl-C
  drops it, and the integration tier's sweep drops a killed one after an
  hour.
- **Rate limits cap some steps' runs** (link import, weather location and
  search, the beacons): their `n` is lower, their p95 rougher.
