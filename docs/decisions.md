# Decisions

Dated decisions, their rationale and the gotchas they carry. Newest last (devkit's docs-check;
the union merge appends); the 2026-10-13 block predates that rule and reads newest first. The
older history lives in `docs/PROJECT_LOG.md`.

## 2026-10-13 — Tier budgets and floors through devkit's tier guard

**Why:** `scripts/ci/budget.sh` and `scripts/ci/test_floor.py` were closet's copy of what five repos built separately; devkit 4f5f282 ships the one implementation (`devkit/bin/tier_guard.sh`).
**Decision:** ci-unit, ci-db and ci-e2e run under `$(TIER) <tier> --budget … --floor vitest=…|playwright=… -- <cmd>`; both scripts, the JSON reporters and `build/test/` are gone, and the floor reads the runner's summary line (tests that ran, as test_floor.py counted). `CI_BUDGET_ENFORCE` is now `TIER_BUDGET_ENFORCE`. Budgets 60/180/180 and floors 1486/4472/10 are unchanged.
**Consequence:** each tier prints one `TIER <tier>` line and writes `build/metrics/tier-<tier>.json` beside `statements.json`. Measured under the lock, 4 workers: unit 1498 tests in 5 s, db 4489 in 103 s, e2e 10 in 17 s.

## 2026-10-13 — devkit 4f5f282: union-merged decisions log, tier names, one tier guard

**Why:** devkit 4f5f282 adds three guards (`docs/decisions.md merge=union`, `ci-<tier>-<area>` target names, no privileged port in a non-root image) and `bin/tier_guard.sh`, the fleet's one budget-and-floor runner.
**Decision:** sync, then adopt in this PR: the union line in `.gitattributes`, and the tier guard in place of closet's own budget and floor scripts (next entry). closet's targets already follow the naming rule and its image runs as root, so neither of the other guards asks for a change.
**Consequence:** two PRs that each append a decisions entry no longer conflict on rebase.

## 2026-10-13 — /health/live and /health/ready

**Why:** `observability.md`'s health contract: closet answered `/healthz` `{status: "ok", version}` checking nothing, the image had no `HEALTHCHECK`, and the smoke's probe could only run `--live`.
**Decision:** `src/web/health`: `/health/live` checks nothing (the PWA heartbeat moves to it, so a down database never reads as offline); `/health/ready` checks `database` + `migrations` (required, one statement under 3 s: the newest recorded migration against this build's) and `cron_jobs` + `cutout_queue` (optional, as locus and Orbit: every page serves without them, and a restart loop would cost the household the app). A timer's hung run is the one way it stops, so `JobRoster` reports a run in flight past 30 min. `/healthz` is the ready handler, for cached clients. Rate-limited per address as the convention says (`HEALTH_LIMIT`, one checker for both paths): closet has no in-container proxy and `TRUSTED_PROXIES` covers Caddy, so no delta. Dockerfile `HEALTHCHECK` on `/health/ready` via node's fetch; the smoke polls it and probes `--live /health/live --health /health/ready`.
**Consequence:** production's container reports health from the next deploy; homelab still has to add the `autoheal: "true"` label (and `pids_limit`, `no-new-privileges`). The image still runs as root (a separate change: the data volume's ownership). Remove `/healthz` once no phone HEADs it (its requests have no access line; the Caddy log shows them).

## 2026-10-13 — Lean test suite: budgets per tier, ten e2e scenarios, migrations once per run

**Why:** the owner directive ("a FAST, lean, useful test suite", 2026-10-13) and the gate's clock: the db tier took 278 s (1479 unit and 3036 integration tests, the latter in 136 files, every file migrating its own database and hashing passwords at bcrypt cost 12) and the e2e tier 356 s (61 Playwright files, 220 chromium tests, most re-proving what the integration tier already proves or what only a phone shows). Specs of shipped migrations tested frozen SQL that no change of ours can break.
**Decision:** budgets in the Makefile (`scripts/ci/budget.sh`: unit ≤ 60 s, db ≤ 180 s, the owner's tier budget: the gate runs it beside e2e and the image build, 160 s there against 83 s alone; e2e ≤ 180 s) with collected-count floors (`scripts/ci/test_floor.py`; UNIT_FLOOR/DB_FLOOR/E2E_FLOOR). Infrastructure first: `PASSWORD_HASH_ROUNDS` (4 in every test tier; refused under 12 when `APP_ENV=production`) and one migrated template database per run (`closet_tpl_<hash of drizzle/>`, cloned per spec file; `test/support/scratch-database.ts`). Then the cuts: the 14 shipped-migration specs and `migrateBefore` (53 tests); Playwright from 61 files to ten scenarios, one per file (login, add from a photo, style an outfit, plan on the calendar, wear and wash, a trip, a shared wardrobe, the offline shell, the worker's update, the image cache across sessions); `screenshots.spec.ts` becomes `make screenshots`, off the gate; the calendar-date sweep keeps boundary years. The gate's image job now runs `ci-image` then `ci-smoke`.
**Consequence:** measured on the Mac under the gate's lock, 4 workers: unit 1486 tests in 11 s; db 1486 + 2986 tests in 83 s (was 278 s); e2e 10 scenarios in 14 s (was 356 s). The floors are those counts. Gotchas fixed on the way: `metrics.spec.ts`'s app_info read whatever commit an earlier `npm run build` left in `public/build.json`, so the db tier failed after an e2e run (it pins APP_VERSION now); Chromium logs a refused login's 401 page as a console error, which the login scenario now expects by name. The worker's stale-page, warm, install and push-settings behaviours lost their browser specs and are verified on the phone before a feature is called done (`test/AGENTS.md`); a migration with a data fix is proved by hand on production-shaped rows in its PR (`src/db/AGENTS.md`). References to retired specs in docs and comments are marked `(retired 2026-10-13)`.

## 2026-10-13 — Observability contract 2: job ids, app_info and db-statement metrics, no-console, request_id in error bodies

**Why:** `observability.md` asks for a `<kind>-<12hex>` id per background run with its `parent_request_id`, `app_info{version}` and `http_request_db_statements`, the `logger` field name, no console in app code, `request_id` in every error body, and devkit's `contract_probe.sh` in the smoke. #381 left these open.
**Decision:** one async store holds a request or a job (`runAsJob`); a job replaces the request, keeping its id as parent. Timer runs are `cron-`, cutout photos `cutout-`. The cutout's parent survives the database queue in a new nullable `file.cutout_request_id`, set where a row enters the queue. Statements are counted by Drizzle's logger hook in the caller's context, proven equal to node-postgres's count. `make ci-db` writes `build/metrics/statements.json` from `recordQueries` blocks only (decision H). `context` became `logger`: nothing in homelab reads it.
**Consequence:** Loki queries on `context` must use `logger`. The smoke probes `--live /healthz`; `--health` waits for `/health/ready`. No ratchet reads `statements.json` until closet's `ci-metrics` lands. Push and MCP outcome words are unchanged (owner decision pending).

## 2026-10-13 — Observability contract: bare sha7 version, JSON logs with request ids, Bugsink environment

**Why:** `observability.md` names one version string (the bare sha7), JSON log lines, a 12-hex `request_id` joining a reply, its log lines and its Bugsink event, and an explicit `environment`. closet reported `sha-<7>`, wrote pino-pretty to Loki, had no request id, and sent smoke boots to Bugsink as `production` (NODE_ENV).
**Decision:** `APP_VERSION` is the bare sha7 (owner decision E); only the image tag keeps `sha-`. `LOG_FORMAT` `json` (default) or `text`; JSON is a sync multistream, since a worker with two targets drops lines whose `level` is a label. One async context (`src/request-context.ts`) carries the id and the request timing; pino's mixin and the tracker read it. `APP_ENV` (production|dev|gate) is the tracker's environment. Job outcomes keep `discarded` and `interrupted` (owner decision C, a Convention delta); errors and timeouts are `failure`.
**Consequence:** Bugsink releases change from `sha-<7>` to `<sha7>` at the next deploy. No Dockerfile `HEALTHCHECK` yet: nothing reads closet's container health (homelab compose has no healthcheck or autoheal label); it lands with `/health/ready`. Still open: `logger` field name, job ids, `app_info`, push/MCP outcome words.

## 2026-10-13 — Docs-check and git hooks via devkit; area docs become AGENTS.md

**Why:** the 36 area docs were real `CLAUDE.md` files, which only Claude Code reads, and closet kept its own docs check (`scripts/claude-md.ts`) and hook runner (`scripts/git-hook.ts`) beside devkit's copies of both. The pre-commit hook ran the integration tier against pgvault-dev, and pre-push ran Playwright on a push to `main`.
**Decision:** every area doc is `AGENTS.md` with `CLAUDE.md -> AGENTS.md`; live references name `AGENTS.md` (history docs keep their wording). `make docs-check` (devkit, in `ci-quick`) owns the pair rule and the 30/16 KB caps; closet's one extra, the root's area index, moved to `scripts/ci/docs_rules.sh`. Hooks are devkit's templates: pre-commit `ci-quick`, pre-push `ci-unit` (`scripts/ci/hooks.conf`); `make install` sets `core.hooksPath`, and the npm `prepare` script no longer does.
**Consequence:** hooks need neither Postgres nor a browser; the integration tier and e2e run only in the gate. `npm run check` no longer includes a docs check. A new area doc must be added to the index and as a pair, or `ci-quick` fails.

## 2026-10-13 — Release identity: APP_VERSION baked into the image, ship tags from CI

**Why:** the image named its build three ways (a full sha in `public/build.json` for the error tracker, package.json's frozen `0.5.1` on /about and MCP, semver tags from `tag-release.yml`), and `/healthz` named none, so nothing said which build production runs.
**Decision:** one string, `sha-<7>`: `ci.yml`'s publish job passes `APP_VERSION` once; the Dockerfile's final stage holds `ARG`/`ENV`/`LABEL org.opencontainers.image.version`; `/healthz` answers 200 `{status, version}`; compose never sets it (`make release-check`). Only that job moves `latest`, then tags `ship-<date>-<sha7>`. `tag-release.yml`, the `v*` trigger, semver and date image tags are retired. The Dockerfile moved to the root (devkit's checks read only that one). Renovate replaces Dependabot.
**Consequence:** the error tracker's releases change from full shas to `sha-<7>`. The beacon accepts any `[A-Za-z0-9._-]` release. The builder stage no longer takes the commit, so `npm run build` stays cached across commits.

## 2026-10-13 — PR gate moves in-repo via devkit; strict protection off

**Why:** the gate was a closet-only script outside the repo, posting three per-job statuses, updating branches for strict protection and merging on its own. Its scratch databases lived on the shared pgvault-dev. Its path map also sent `test/support/**` to the browser job only, skipping the integration tier that imports it.
**Decision:** devkit's shared skeleton (`make gate PR=<n>`) runs this repo's Makefile `ci-*` targets from `scripts/ci/gate_plan.sh` and posts one `local-gate`. Protection requires `local-gate` + `codex-review` with strict off. The merge queue merges only when the head and `main` it gated are still current, pinned with `--match-head-commit`. That is the guarantee strict gave, without update-branch or carrying `codex-review` over. Tests run on a throwaway Postgres 18 container (`devkit/bin/throwaway_pg.sh`), never pgvault-dev. Fork PRs are refused (public repo; `GATE_ALLOW_FORKS` stays 0).
**Consequence:** a hand merge in the UI can use a `local-gate` from an older `main`; its description names that `main` ("Passed on main abc1234"). Coordinators never enable auto-merge. A check changes in the Makefile, never in the plan or `ci.yml`.

## 2026-10-13 — devkit e7b19d7: hook steps scoped by changed paths, standard docs set

**Why:** devkit e7b19d7 fixes the gate log race, scopes hook steps from one fleet layout table, and adds docs-check rules 6-10 (standard README sections, dated decisions, real `make` targets and links), warning until 2026-11-15.
**Decision:** sync with no `scripts/ci/hooks.conf` change; closet's layout needs no override. A docs-only commit skips `ci-quick` and `ci-unit` and the hook runs `make docs-check` itself; any other change runs every step as before. The README gains Architecture, Deploy and Documentation sections that point at the existing docs.
**Consequence:** a docs-only commit or push checks only the docs locally; the gate stays authoritative. `docs_check.sh` reports no warnings under a 2099 date, so the 2026-11-15 flip needs no closet change.

## 2026-10-14 — db tier under budget: integration workers share their module graph

**Why:** `make ci-db` ran 173–176 s in the gate against its 180 s budget (78 s solo). A third of its CPU was each of 122 integration spec files importing the app's module graph afresh (about 1 s each), plus a cold first boot per process.
**Decision:** the integration project runs `isolate: false`, overturning the 2026-09-25 rule whose blocker (config read from env at import) `createApp(config)` removed. Route tables move to `authorization-<group>.routes.ts` (Vitest never re-imports a test file); `createApp`'s `onRoute` option replaces the coverage spec's `fastify` mock; eslint bans `vi.mock`/`doMock` in `test/integration/`; `shared-worker-setup.ts` restores timers, envs and globals per file. The fixed 5 s lock and stop timeouts stay: production constants, idle not CPU.
**Consequence:** solo 78 s → 45 s; gate 173–176 s → 51 s (56 s beside e2e and an uncached image build). Budget 180 → 110 s; floors unchanged (4489 ran). Proof of no leak (#387): one-worker and two shuffled runs gave the isolated run's outcomes per test and its `statements.json` byte for byte.

## 2026-10-15 — devkit 51a7bb5: one path classification for hooks and gate

**Why:** devkit 51a7bb5 moves the fleet's path table into `bin/_paths_lib.sh`, shared by the hooks and the gate, and adds `devkit_default_gate_plan`; a devkit-only change is now "tooling".
**Decision:** sync with no hooks.conf change (the hooks treat tooling like other, so local steps are unchanged), then convert the gate plan to the default (next entry).
**Consequence:** the tier guard's git-root lookup now ignores a hook's exported `GIT_DIR`, so `build/metrics/` always lands at the checkout root.

## 2026-10-15 — Gate plan on devkit's default; closet's db/e2e rules in gate_plan_extra

**Why:** every devkit sync ran db + e2e (~4–5 min) because the old plan's own path loop called `devkit/` app code; devkit 51a7bb5 classifies those paths as tooling.
**Decision:** `scripts/ci/gate_plan.sh` declares QUICK (`deps` + `quick`), DOCS and IMAGE (`GATE_AREAS_IMAGE=""`, image paths only) and calls `devkit_default_gate_plan`. db and e2e stay closet's per-path rules in `gate_plan_extra`, not BACKEND/E2E groups: all of closet is the fleet's "other", and an area group would run both tiers for a Playwright-only or `.github`-only change.
**Consequence:** docs-only runs docs-check without `npm ci`; devkit-only runs deps + quick; a change to devkit's contract probe runs the image job (it ran db + e2e and no image before). The image job now runs before db and e2e. The plan is read from the invoking checkout, so the PR that changes it is gated by `main`'s copy.

## 2026-10-15 — The image runs as uid 1000; readiness checks storage is writable

**Why:** delivery.md / observability.md want non-root images, and closet's ran as root. Its two runtime directories are host mounts that keep the host's ownership, so a non-root image on a root-owned one is Orbit's port-80 outage class: the Mac smoke passes, production breaks. Measured against the code, a root-owned DATA_PATH already crashed the boot (a bare EACCES from opening app.log), while a root-owned MODELS_PATH would have read `up` and failed only the model download.
**Decision:** `USER node` (node:22-slim's uid/gid 1000) after chowning only `/app/data` and `/app/models`, the process's only runtime writes (HOME `/home/node` is already its own). `src/storage-probe.ts` (a real create + unlink, not mode bits: the data share is NFS squashed to the NAS admin) feeds a required `storage` check on `/health/ready` (cached 5 s) and main.ts's refusal of an unwritable DATA_PATH, both naming the chown. The smoke boots on Docker volumes (a macOS bind mount lets every uid write) and proves uid 1000, then a root-owned data volume (boot refused) and a root-owned models volume (503, `storage` down).
**Consequence:** deploy ORDER: closet autodeploys `latest` from main, so the owner chowns linux-box's `/srv/docker/closet/models` to 1000:1000 and proves both directories writable as uid 1000 (`docs/operations.md#permissions`) BEFORE this merges; then `docker exec closet id -u` is 1000 and an upload works. homelab's compose comment "The image runs as root" changes with it.
## 2026-10-16 — Metrics ratchet: ci-metrics on devkit's collectors; coverage stays in vitest for now

**Why:** owner decision C4 puts closet's static numbers and coverage under devkit's ratchet (devkit f756b39), so a PR can only leave them as good as `main`.
**Decision:** `scripts/ci/metrics.conf` runs `ts.mjs` over `src` (scope `backend`, area `other`: cyclomatic, cognitive, knip, cycles) and `jscpd.mjs` over `src`; `docs/metrics/ratchet.json` holds every key they emit at today's value. No bundle key: the build is tsc, not vite. `knip.jsonc` declares the entry points and importmap names knip cannot see, so `dead.*` counts dead code. The four tools are pinned exactly, as in finplat.
**Not yet:** coverage. Its report comes from `ci-db`, which skips `.github`-only, Playwright-only and tooling PRs, while devkit runs every collector on any `other` or `tooling` path. A coverage collector would then fail for a missing report. The vitest thresholds keep gating coverage until devkit can skip a collector whose producing job did not run. The same gap keeps `statements.*` (from `ci-db`) and `audit-pages` statements untracked.
**Consequence:** `make ci-metrics` takes about 30 s, almost all of it two type-aware eslint passes. It is the gate's last job on every non-docs PR, devkit syncs included.

## 2026-10-16 — devkit 8236095: knip's unused files counted; closet's bound of 0 holds

**Why:** devkit #36 fixes `ts.mjs`, which read a `files` array knip 6 no longer fills, so `dead.*.knip_files` was 0 everywhere.
**Decision:** sync. Re-measured with the fix, closet's `dead.backend.knip_files` is still 0 (`knip.jsonc` declares every entry point), so the bound merged in #391 stands; no rebaseline.
**Consequence:** a new unreferenced file under `src/`, `scripts/` or `test/` now fails `ci-metrics`; declare a real entry point in `knip.jsonc`, never to hide one.

## 2026-10-16 — Coverage moves into the metrics ratchet (C4); vitest thresholds deleted

**Why:** decision C4 wants one place to gate coverage. devkit f6bf01f lets a collector name the gate job it reads (`job:db`), so it is SKIPPED, not failed, when the gate skips db (`.github`, Playwright-only, tooling PRs).
**Decision:** `make ci-db` adds the `json-summary` reporter. The `cov` collector (`job:db`) turns it into `coverage.backend.lines` 97.43 and `branches` 92.36, both today's values, direction higher. The four vitest thresholds are deleted. Functions and statements are no longer gated: the fleet key set is lines and branches, statements track lines, and functions jitter (two runs differed by one function in `src/db/client.ts`; lines and branches were identical).
**Consequence:** a coverage drop fails `ci-metrics`, not `test:cov`, and `ci.yml`'s db job no longer gates it. The bounds and the conf are `other` now and run db only (`gate_plan_extra`), so the coverage keys are measured, not skipped. `statements.*` and `audit-pages` stay untracked.

## 2026-10-16 — Layer direction through devkit's layer guard; knip and jscpd bases

**Why:** closet's layering was lint-only and covered the pure layers; nothing held db below web or metrics below db. devkit f7ee75e ships `bin/layer_check.py` and the collectors' base configs.
**Decision:** `scripts/ci/layers.conf` declares src/ bottom-first (shared, infra|pure, metrics, db, cutout, web, maintenance, seed; entries on top) as the code obeys it today. `make layer-check` joins ci-quick and the `layers` collector (`repo`, so a conf-only PR is measured) gates `coupling.backend.layer_violations` at 3: metrics imports the auth cookie name, the token prefix and `isWarmRequest` from web, each a `known` line with its fix. `db/schema.ts -> cutout/state.ts` is an `allow`: a constant module that imports nothing, taken as the schema takes the pure layers' enums. ESLint keeps the package bans.
**Consequence:** `--knip-base` drops four knip.jsonc lines; `--base` gives jscpd the spec exclusion closet never had, so clones fell 45 to 33 and the percent 0.5 to 0.43 (tightened, with branches 92.37).

## 2026-10-16 — Convention deltas declared

**Why:** the fleet matrix (2026-10-16) found three deliberate gaps with no line under `## Convention deltas`: no pull-request job in Actions, a scheduled `nightly.yml`, and the own image smoke instead of devkit's `boot_image.sh`. `job_last_success` sat in an "open gaps" note. The docs diet also limits root AGENTS.md to the standard H2s.
**Decision:** declare the three as deltas. The PR gate is `local-gate` (2026-10-13). The nightly runs the page audit, Lighthouse, the real cutout model and WebKit, which no PR should wait for. `scripts/smoke-image.sh` boots on the host network (`boot_image.sh` uses a private one) and still runs devkit's `contract_probe.sh`. `job_last_success_timestamp_seconds` and the push and MCP outcome words go under `## Deliberate exceptions`. Conventions, Changing the schema, Deployment and Gotchas become H3s, verbatim. One-off audits and superseded plans move to `docs/reports/`, while plans cited from source stay in `docs/plans/`. `docs/deployment.md` becomes `docs/operations.md`.
**Consequence:** the fix hints in the storage and health checks now name `docs/operations.md#permissions` and `#health`. `ci.yml`'s comment still names `docs/deployment.md` until the next workflow change. A new plan cited from code is linked from README.

## 2026-10-16 — Statement budgets join the ratchet at tolerance 0

**Why:** `make ci-db` already wrote each route's statement maximum, but into build/metrics/, which metrics_collect.sh clears, and no collector read it: an N+1 regression passed the gate.
**Decision:** the fixture writes `build/statements.json`; devkit's shared collector `devkit/metrics/statements.py` (decision H) validates it into `statements.<METHOD>:<route>` keys, `job:db` in scripts/ci/metrics.conf, `--min-routes 87` (today's count). The 87 keys were seeded by a rebaseline that moved no other bound.
**Consequence:** one more statement on any pinned route fails ci-metrics. A route that legitimately needs more is a bound edit in docs/metrics/ratchet.json with the metrics-rebaseline label; a new recordQueries route raises --min-routes in the same PR.

## 2026-10-16 — Scorecard sync: sizes, fan-out and vulnerabilities measured; secrets guard in ci-quick

**Why:** the scorecard's T2, T4 and T11 rows had no number in closet: file size, module fan-in/out and dependency advisories were unmeasured, and nothing stopped a committed credential.
**Decision:** devkit main's `size.py` and `vuln.py` collectors plus `--fan` on ts-backend, all area `other` (all of src/ is other). size and coupling bounds were seeded at today's values (max_lines 2295, over_600 15, fan_in 122, fan_out 36); vuln is report-only (the ratchet never tracks it: it needs network). `make secrets-check` runs in ci-quick; `scripts/ci/secrets_allow.txt` names the page audit fixture's fake signing key.
**Consequence:** a file growing past its bound or a new 600-line file fails ci-metrics. Today's OSV hits (1 critical, 10 high) are fixed in a separate runtime PR the owner merges.

## 2026-10-16 — Dead exports deleted; knip_exports bound tightened

**Why:** knip reported 200 exports and types no other module imports, so the scorecard's T3 (dead code) read F and every new unused export hid among them.
**Decision:** 187 lost only the `export` keyword (each is used inside its own file). Ten e2e helpers orphaned when PR #383 cut the e2e specs were deleted. Three `as const` arrays read only to derive a type (GARMENT_PROPERTIES, the forecast's CONDITIONS, FIT_PROBLEMS) became plain union types. Nothing went into knip's ignore list.
**Consequence:** `dead.backend.knip_exports` is bound at 0. Export a symbol in the same change that imports it from another module; a test needing an internal goes through the module's public behaviour.

## 2026-10-16 — Layer debt paid: metrics never imports web

**Why:** three `known` lines in `scripts/ci/layers.conf` let src/metrics reach into src/web for the session cookie's name, the personal token prefix and `isWarmRequest`.
**Decision:** the two credential names move to `src/credential-names.ts` and the warm marker (header + `isWarmRequest`) to `src/warm-request.ts`, both in the `shared` layer; every consumer (web/auth, the service worker, app.ts) imports them there, with no re-export left behind.
**Consequence:** no `known` lines remain and `coupling.backend.layer_violations` is bound at 0: a new metrics→web import fails ci-quick.

## 2026-10-16 — devkit c9ef303 and the scorecard ratchet

**Why:** the scorecard grades closet per track, but nothing stopped a PR from lowering a track's pass share.
**Decision:** `docs/metrics/scorecard.json` is committed from `scorecard.py . --mode rebaseline`; `make ci-metrics` (metrics_collect.sh) then runs `--mode check` after the metric bounds and fails a PR whose ratcheted track (T1-T6, T10, T12, T14) drops. Baseline: closet D.
**Consequence:** letters only rise from here; a PR that raises a share runs `--mode tighten` and commits the file. The `metrics-rebaseline` label is the escape hatch, as for the metric bounds. Also moved the 2026-10-16 layer-debt entry to the end, where docs-check's newest-last rule wants it.

## 2026-10-17 — Guard kit and the ESLint base adopted (devkit 164aeb5)

**Why:** devkit now judges code-structure rules from one conf (`guard_check.py`) and ships a shared ESLint base; closet is the TS canary the other repos copy.
**Decision:** `scripts/ci/guards.conf` declares five rules no lint rule held: the outbound-fetch door (sockets, DNS, `node:http` and global `fetch` only in `outbound-fetch.ts`; `errors.tsx` reads STATUS_CODES), no `Math.random`, no `loadConfig` in src/web. `make guard-check` runs in ci-quick; ratchet key `guards.backend.known` (bound 0). No test was deleted: `photo-ref-guard.spec.ts` stays (type-only imports are erased and its other three checks scan SQL text). ESLint spreads `devkit/lint/eslint.base.mjs` first; closet's src-only `no-console` became a scripts/test exemption.
**Consequence:** `scripts/preCommit.sh` (a second gate) is gone; the docs name the real merge (`gh pr merge --squash --match-head-commit`), not a script that never existed. `migration_check.py` is not wired: it reads `drizzle/meta/_journal.json`, which every new migration appends to, as a shipped edit. `coverage.backend.branches` drops 92.37 → 92.36 under `metrics-rebaseline`: origin/main measures 92.36 on 2026-10-17 with no src change, so a branch depends on the day.

## 2026-10-17 — Complexity sweep, error text through errorFields, migration guard wired (devkit 16fa637)

**Why:** the ratchet holds two functions over cognitive 15. devkit #86 and #91 made three closet gaps expressible: names from `node:http`, the drizzle journal append, and logger calls that splice error text. The new rule found ten such calls (a fetch or driver error can quote a URL with its token). Pino's default serializer also wrote every `{ err }` raw, with all of the error's own fields.
**Decision:** `decideSuggestion` hands its bought and dismiss-group arms to functions, as undo-group already did, and `decideOnPick` does the same with dismiss-pick, with `settledBy` naming the "reopens its need" test. `crossFieldProblems` hands over the order-mail group. `errorFields` (src/logger.ts) is every logger's `err` serializer: it redacts URLs (not file:// frames) and `key=value` pairs, keeps type, code, status, causes and the stack, and drops other fields. Unlike rollcall's helper it keeps the stack, because errors.spec holds "a 500 logged with its stack". `@outbound-http-sockets` bans the socket names; `migration-check` runs in ci-quick.
**Consequence:** log lines change: those ten messages lose the error text, which is now under `err`, and every `err` is redacted. The names ban is a deny-list: `import * as http` in errors.tsx would pass it. `readInbox` (cyclomatic 14, a flat list of optional reads for one statement) is why cyclomatic_max stays 14.
