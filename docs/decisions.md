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

## 2026-10-17 — pre-commit split: typecheck and unit run at pre-push

**Why:** the scorecard's T8 read pre-commit p90 33 s (budget 30 s): the hook ran all of ci-quick, and a fresh worktree's first eslint is cold, with prettier run twice (format:check, and again as an eslint rule).
**Decision:** as rollcall #56: pre-commit = ci-guards + `secrets_check.sh --staged` + ci-lint; pre-push = ci-typecheck + ci-unit. ci-quick is the union of the Makefile parts, so the gate and ci.yml are unchanged. eslint-plugin-prettier is dropped for eslint-config-prettier: formatting is format:check's alone.
**Consequence:** a type error is caught at push, not commit. A new ci-quick part goes into a hook step too (scripts/ci/hooks.conf).

## 2026-10-17 — The outfit destination has one owner: query, body, hidden fields and label

**Why:** `src/web/outfits/destination.ts` documented itself as the one parser and writer of `?for=`, yet the `for`/`occasion`/`replace` query schema was spelled in five routes, the hidden fields that post it back in the gallery and Styling, the pick label ("Plan for Tuesday", "Add to the trip") in both pages, and the posted body's pattern in `schemas.ts` beside the module's own format constants. jscpd counted four of the 33 clone blocks here; the refactor skill's drift lens (two writers of one policy, a documented owner bypassed) picked it over the larger capsules/trips form group, whose copies are design (two products, no owner yet).
**Decision:** the module (now `destination.tsx`) owns `DestinationQuery` (lenient strings, spread into a page's querystring), `DestinationBody` (strict, a write's) and `DestinationFields` (the hidden fields); `destination-views.tsx` (was `day-destination.tsx`) owns what the pages say of one, `DayDestinationLine` and `destinationPickLabel`, because the label needs `t` and `coupling.backend.fan_in_max` is i18n's importer count (122): the parser module importing it would have raised that bound. Every feature spreads or renders them. `destination.spec.tsx` proves the round trip: what `DestinationFields` writes, `DestinationBody` accepts and `parseDestination` reads back. No guards.conf rule: the guard grammar has no "only this file spells this attribute" kind; the ratchet's `duplication.repo.clones` 33 → 30 and `jscpd_percent` 0.43 → 0.38 hold the consolidation.
**Consequence:** a feature spelling the `day:`/`trip:` format, a `for: Type.Optional(Type.String())` of its own, or a label switch on the kind is a regression (calendar and outfits AGENTS.md). One form keeps writing the field names by hand: the plan sheet's GET into Ideas, whose occasion is the user's radio choice, so a posted-back destination component cannot carry it; its `for` value is `destinationTarget`'s (Codex review of #408). Old builder links (`/outfits/new?for=…`) now also carry `replace` through to Styling, as every other reader did. Remaining clone groups for the next lane: capsules/trips forms (6 blocks, design until a shared field component exists), gallery/styling query shape beyond the destination (`capsule`, `with`), the four photo route preludes, the two cron timers.

## 2026-10-17 — Complexity sweep, error text through errorFields, migration guard wired (devkit 174d401)

**Why:** the ratchet holds two functions over cognitive 15. devkit #86 and #91 made three closet gaps expressible: names from `node:http`, the drizzle journal append, and logger calls that splice error text. The new rule found ten such calls (a fetch or driver error can quote a URL with its token). Pino's default serializer also wrote every `{ err }` raw, with all of the error's own fields.
**Decision:** `decideSuggestion` hands its bought and dismiss-group arms to functions, as undo-group already did, and `decideOnPick` does the same with dismiss-pick, with `settledBy` naming the "reopens its need" test. `crossFieldProblems` hands over the order-mail group. `errorFields` (src/logger.ts) is every logger's `err` serializer: it redacts the error tracker's credential shapes (now `src/secret-text.ts`, one list for both; a Drizzle `params:` tail included, Codex review), URLs (not file:// frames) and `key=value` pairs, keeps type, code, status, causes and the stack, and drops other fields. Unlike rollcall's helper it keeps the stack, because errors.spec holds "a 500 logged with its stack". `@outbound-http-sockets` bans the socket names; `migration-check` runs in ci-guards (the pre-commit hook and ci-quick).
**Consequence:** log lines change: those ten messages lose the error text, which is now under `err`, and every `err` is redacted. The names ban is a deny-list: `import * as http` in errors.tsx would pass it. `readInbox` (cyclomatic 14, a flat list of optional reads for one statement) is why cyclomatic_max stays 14.
**Decision:** `decideSuggestion` hands its bought and dismiss-group arms to functions, as undo-group already did, and `decideOnPick` does the same with dismiss-pick, with `settledBy` naming the "reopens its need" test. `crossFieldProblems` hands over the order-mail group. `errorFields` (src/logger.ts) is every logger's `err` serializer: it redacts URLs (not file:// frames) and `key=value` pairs, keeps type, code, status, causes and the stack, and drops other fields. Unlike rollcall's helper it keeps the stack, because errors.spec holds "a 500 logged with its stack". `@outbound-http-sockets` bans the socket names; `migration-check` runs in ci-quick.
**Consequence:** log lines change: those ten messages, and five the rule cannot see (a describe helper, a `why` string, a child process's reply, a connection reason, `String(error.cause)`; Codex on #406), lose the error text, which is now under `err`, and every `err` is redacted. A push failure logs its HTTP status, not the push service's body. The names ban is a deny-list: `import * as http` in errors.tsx would pass it. `readInbox` (cyclomatic 14, a flat list of optional reads for one statement) is why cyclomatic_max stays 14.

## 2026-10-17 — Runner images pinned to ubuntu-24.04 (devkit 174d401)

**Why:** `ubuntu-latest` moves to a new OS on GitHub's schedule, so a green workflow can turn red with no commit here; devkit #105 makes workflows-check fail on it.
**Decision:** every job in ci.yml and nightly.yml runs on `ubuntu-24.04`.
**Consequence:** a newer image is a deliberate PR that changes the pin and watches ci.yml and the nightly run once.
**Rebaseline:** devkit #108 drops Markdown, text and lockfiles from jscpd's denominator, so `duplication.repo.jscpd_percent` reads 0.39 on main's own tree (0.38 before) with the same 30 clones; that one bound moves (label `metrics-rebaseline`). `make metrics-rebaseline` is now a target, as the ratchet's failure message assumed; it would also have dropped the report-only `fan_in_max`, which stays.

## 2026-10-17 — One owner per transaction (devkit bca8cbd: own-transaction, report-only.json)

**Why:** the scorecard read `arch.own_commit` UNMEASURED: drizzle has no session object for devkit's Python tracer, and closet spells a transaction `db.`, `this.db.` and raw `BEGIN` in `client.query`.
**Decision:** guards.conf `@own-tx` (devkit #113) lets only the query/write modules it lists and `src/db/migrate.ts:recordBaseline` open, commit or roll back a transaction; 0 violations on main, and a planted `db.transaction(` in `src/web/wardrobe/urls.ts` fails it. `docs/metrics/report-only.json` (devkit #112, written by `make metrics-tighten`) carries `vuln.*` and `fan_in_max` to the scorecard.
**Consequence:** a new transaction site joins an owner module or the line, in the same PR. T4 0.6 → 0.8.

## 2026-10-17 — devkit c2d7e22: image for every app path, sonarjs rules, rebaseline KEYS

**Why:** devkit #115 refuses `GATE_AREAS_IMAGE`; closet's `""` had let #404, #406, #408 and #409 merge src/ changes no image build or smoke booted. devkit #110 exports sonarjs rule maps, and #116 makes a rebaseline name its keys.
**Decision:** the override is gone and `GATE_IMAGE_PATHS` with it (every path it named is already an app path). `GATE_IMAGE_EXCLUDE_PATHS` lists the app paths no Dockerfile stage COPYs (there is no .dockerignore). eslint registers sonarjs for every linted file with `sonarjsRules`, and specs get `sonarjsTestRules`. The 75 findings (40 nested ternaries, 35 duplicate strings) became named helpers, lookup maps and one-owner consts; outcome tags such as `NOT_ALLOWED` are `as const` values the union types derive from. `make metrics-rebaseline` documents `KEYS=`.
**Consequence:** a new nested ternary or a literal repeated three times fails ci-lint. A new Dockerfile COPY of an excluded path must drop it from the exclude list. Splitting the ternaries put two untested branches on lines of their own, so `weather/views.spec.ts` now pins the push's weather text.

## 2026-10-17 — One owner for a form field's invalid state

**Why:** jscpd's form-field group (pass 2 of the clone ratchet) was drift, not design. Eight copies of label + input + messages decided "this field was refused" in three shapes: capsules and trips never announced their messages (no `role="alert"`), and the garment form, repair log, "Bought it" and fabric weight were red without `aria-invalid`. Only link import also tied the input to its message (`aria-describedby`).
**Decision:** `src/web/form-field.tsx` owns it: `FormField` (label, control, `FieldMessages`) and `inputAttributes` (id, classes, `aria-invalid`, `aria-describedby`); `Messages` and `inputClass` left `layout/parts.tsx`. guards.conf `@field-invalid` holds `input-error` and `aria-invalid` to it and to `auth/form.tsx`, whose inline-check slots are a separate design.
**Consequence:** a refused input is now invalid, described and announced on every post form (the colour dropdown's messages are announced only). That is an accessibility-tree change, not a visual one. The capsule/trip create-edit page frame is still two copies; their offline-guard difference is #411. `coverage.backend.branches` was rebaselined 92.49 to 92.48 (label metrics-rebaseline): about 35 covered duplicate branches were deleted and 14 covered ones added, a denominator effect, not lost coverage.

## 2026-10-17 — One owner for the checklist protocol

**Why:** jscpd's pass-2 groups held three hand-written checklist bodies (two in capsules, one in trips) and four hidden `shown` inputs. Trips imported `unchecked` from capsules' validation, a cross-feature reach. The two trip writers resolve an id sent as both packed and unpacked differently (`setPacked` packs it, `setItemsPacked` unpacks it); no post reaches that, since `unchecked` never returns a checked id.
**Decision:** `src/web/checklist.tsx` owns `checklistBody(field, maxItems)`, `unchecked` and `ShownId`. Posted names (`ids`, `capsuleIds`, `packed`) and caps (2000, 500) stay per list, because cached pages post them. guards.conf `@checklist-shown` keeps `name="shown"` there.
**Consequence:** the schemas and rendered markup are unchanged. A new checklist starts from the owner; a hand-made `shown` input fails ci-quick.

## 2026-10-18 — One owner each for the place picker and the timer loop (clones 25 to 22)

**Why:** pass 3 of the clone ratchet. The home city and a trip's destination each owned the place search: the field's 2–100 bounds, the query schema, the try/catch answer, the result list, the posted coordinates and the body schema (trips' said "the weather's own shape", a copy held by a comment). `scheduleNightly` and `scheduleMinutely` each carried the timer loop, the cron job per run and the bounded stop.
**Decision:** `src/web/weather/place-picker.tsx` owns the picker (each picker brings only its `Form`); `scheduleJob` (`src/maintenance/scheduled.ts`) owns the loop, the two schedulers bringing only `untilNext`. guards.conf `@place-fields` and `@cron-loop` hold each to its owner. devkit synced to c411302 (jscpd_percent report-only); its devkit-check reads gate_plan.sh from disk unless `--staged`, so the pre-commit hook's guards step is now `ci-guards-staged` (Codex review).
**Consequence:** rendered markup is byte-identical (old and new components rendered side by side). A trip's picked name is now capped by the picker's 200, equal to `TRIP_DESTINATION_MAX`. Left as design: the capsule/trip create-edit frame (#411 rides on it), plan/trip add page tails, the capsule/inbox `resolve` prologue, the parts.tsx icon wrappers, schema and query twins. Link tabs and the sheet backdrop follow in their own PR. `make metrics-tighten` now drops the report-only bounds (`jscpd_percent`, and `fan_in_max`, 123 with the picker's i18n import) from ratchet.json; both stay in report-only.json.

## 2026-10-18 — One writer each for link tabs and the sheet backdrop (clones 22 to 19)

**Why:** the clone ratchet's pass 3, second half. The Wardrobe, Outfits and Calendar tab bars each wrote a link tab's role, `tab-active` and `aria-selected` by hand, and nine dialogs wrote their tap-outside close (`modal-backdrop`).
**Decision:** `LinkTabs` (`src/web/layout/link-tabs.tsx`; a `false` entry is a tab left out) and `SheetBackdrop` (`layout/parts.tsx`) own them. The backdrop's label stays each sheet's: Cancel on the plan sheet and Styling's save, which ask a choice, Close elsewhere. guards.conf `@link-tabs` and `@sheet-backdrop` fail a hand-written copy.
**Consequence:** the tab bars render byte-identical markup (old and new rendered side by side). The selfie viewer's backdrop button loses a redundant `type="submit"`, the default for a button in a form. `coverage.backend.branches` was rebaselined 92.48 to 92.47 (label metrics-rebaseline): the three tab bars' twelve covered branches became `LinkTabs`' six, all covered, a denominator effect; the gate read 92.47 twice where a local run reads 92.48.

## 2026-10-18 — devkit 7ed3645: `make merge` is the merge path; gains lock in; scorecard v2
- **Why:** no paid GitHub features (owner, 2026-10-18), so the merge itself must check the gate; and a ratchet that tolerated BETTER let gains slip back.
- **Decision:** `make merge PR=<n>` (devkit/bin/pr_merge.sh) is the only merge: `local-gate` and `codex-review` (`GATE_MERGE_REQUIRES`) success on the exact head, `main` unmoved since the gate. `ci-metrics` fails on BETTER until `make metrics-tighten`; size, jscpd percent and fan-in are report-only (docs/metrics/report-only.json). `ci-smoke` runs under the tier guard (120 s) and `ci-image` under `docker_bounded.sh`.
- **Consequence:** `docs/metrics/scorecard.json` holds only the WIRED share (19/19 repo-scoped). The machine-scoped gh shim is not installed here yet, and BITE's unguarded count is the pre-local-gate merges up to #376, ageing out of the 30-day window.
- **Gotcha:** `metrics-tighten` locks in any gain, even inside the ratchet's 0.05 float tolerance; branch coverage moves 0.01 run to run (v8 merging of `wardrobe/destination.ts`), so a 92.48 tighten failed the next gate as WORSE. Leave sub-tolerance coverage gains at main's bound.

## 2026-10-19 — An add or edit page is one frame, disabled offline (#411; clones 19 to 16)
**Why:** `PostForm`'s offline guard (`needsNetwork`) was each page's opt-in, and only the trip form had opted in. A cached capsule, garment or "Bought it" form opened offline posted into the worker's offline page and lost what was typed, and the capsule's Delete stayed live. That breaks AGENTS.md's "unreachable writes are disabled with a reason, never dropped". The capsule/trip create-edit frame was also the clone triage's last drift group (#412, #414).
**Decision:** `FormPage` (`src/web/layout/form-page.tsx`) owns the frame: the `formPage` app bar, `PageMain`, one always-guarded `PostForm`, Cancel then the submit, and a guarded Delete. The four forms bring only their fields. `@form-page` (guards.conf) keeps `<CancelLink` there; `expectOfflineGuarded` tests each form. connectivity.js logs how many write controls it disabled. Not chosen: `needsNetwork` on by default in `PostForm`, the issue's owner call, since 14 other PostForms (login, tokens, link import) would change too.
**Consequence:** the four forms are disabled offline with the banner's reason. Visible: trips and capsules put Cancel before Save, both full width, as the garment form did; the capsule, trip and "Bought it" columns are `narrow` (40rem, was 32rem; phones unchanged). The repair log's note and day now carry the required mark (the issue's side note). jscpd's share fell 0.23% to 0.19%.

## 2026-10-19 — devkit 367dc33: recipes on the Node pin, changed-file expression complexity
- **Why:** devkit-check warned that a hand-run make used PATH's Node, not `.nvmrc`'s (devkit #166); `sonarjs/expression-complexity` has 2 findings on main, so it cannot join the whole-tree rules yet (#161).
- **Decision:** `SHELL := devkit/bin/toolchain_shell.sh`; ci-lint runs `changed_lint.py eslint` over src, test and scripts, the files lint:check reads. A planted six-term `&&` in a changed file fails it; five terms pass. A hand run's ci and smoke container names carry the worktree (`throwaway_pg.sh name`, #162); devkit-check missed the old literals because they sat in `?=` variables. renovate.json already extends the preset with no automerge.
- **Consequence:** a new chain of five or more operators fails the PR that writes it; the 2 existing drain as their files are touched, then the rule moves into eslint.config.mjs. Metrics 100 SAME, 0 tightened; scorecard wired 24/24.

## 2026-10-21 — devkit 401c9b7: metrics merge per key, vitest timeouts stretch with load
- **Why/Decision:** `.gitattributes` routes docs/metrics/*.json through devkit's per-key merge driver (#176; `make install` sets it per clone); vitest.config.ts wraps its 30 s timeouts in `loadScaled` (devkit/lint/vitest.base.mjs, #175), so a gate on a box above its core count stretches them by `DEVKIT_LOAD_SCALE` (cap ×2).
- **Consequence:** `coverage.backend.branches` rebaselined 92.47 to 92.46 (label metrics-rebaseline): an untouched origin/main tree reads 8642/9346 = 92.46 today, file for file the same as this branch. The bound has drifted 92.48, 92.47, 92.46 over three days with no source change, which points at a date-dependent branch in a spec; open, not chased here.

## 2026-10-22 — Vitest tiers rerun with the clock shifted; coverage no longer moves with the date (devkit 31d9f2a)
**Why:** devkit #212 added the vitest half of the clock shift. Closet's db tier failed 6 specs at +30d/+365d, and its covered branches read 8643, 8644, 8642 of 9346 at 0, +30d, +365d: the drift the 2026-10-21 entry left open.
**Decision:** `GATE_JOBS_CLOCK` names `ci-unit` and `ci-db` (scripts/ci/gate_plan.sh); vitest.config.ts lists devkit's clock-shift setup files (since 2026-10-26 its `clockShift()` plugin). Root fixes: `pending_photo` rows take `created_at` from the app's clock, the clock reconciliation's cutoffs already use (3 specs); photo-storage.spec.ts dates its live file from the clock `prepare()` reads (1). The 2 muse-round-close specs stay in clock_shift.conf: the Muse writes and their quiet window are Postgres `now()` across decisions, feedback and rounds by design (shared instants, the feedback margin), not a small binding. The drift's sources: trips.spec.ts, the gallery's weather block and mcp-statements.spec.ts pin `Date` to `STUB_WEATHER_NOW` (the stub's weather and the seed's history are the date's); a `roundWhat` spec and a deterministic stale-need 409 (the two-phone race reached it only some runs, muse-inbox.spec.ts) cover branches only a shift or the scheduler reached.
**Consequence:** 8645/9346 covered at 0 (twice), +30d and +365d. The three pinned blocks no longer see the shift (a pin is what it checks for); a new weather or seed spec pins too. The CLOCK group runs on every "other" path, so a .github- or Playwright-only PR pays two more unit and db runs per offset.

## 2026-10-22 — Every PostForm is disabled offline unless it says why (#411)
**Why:** owner, 2026-10-22: "the offline guard is ON BY DEFAULT for every PostForm." #417 guarded the four `FormPage` forms; 15 others still posted from a cached copy into the worker's offline page. 14 are now guarded: sign in, register, email, password, account deletion, two token forms, link import, laundry, sharing, the add sheet's two photo forms, cutout retry, bulk select.
**Decision:** `PostForm` always renders `data-needs-network`; `allowOffline="<reason>"` (rendered `data-allow-offline`) is the only opt-out, and guards.conf `@post-form-offline` refuses one without a 12+ character literal. connectivity.js guards a form's `elements`, so a `form=` control outside it needs no marker: "Add a copy" lost its own, as did laundry's Mark washed inside its form. One opt-out: the styling form, since a guarded form is dimmed whole and its strips must stay usable offline ("choosing still works"); its Save, Shuffle, picks and + Add row carry their own markers (Add row's is new: it sent the rows' inputs, which a guard would have dropped). `expectFullPage` fails any unguarded PostForm on every page; `test/offline-writes.spec.ts` checks the browser.
**Consequence:** visible: those forms' controls, submit included, are disabled and dimmed while offline. htmx writes outside PostForm that carry no typed input (garment and outfit menu actions, a calendar entry's ×, the invite link, the push test, the inbox's seen mark) stay unguarded; every one holding input already was.

## 2026-10-21 — `make merge` requires Codex's review of the head (GATE_CODEX_REVIEW=1)
**Why:** `GATE_MERGE_REQUIRES=codex-review` wants only a success status, whatever commit its text names, so a head Codex never reviewed (failed, missing, or reviewed an older commit) merged on any codex-review success. devkit #189 made the stricter check opt-in; the fleet opts in.
**Decision:** only `make merge` reads it. A failed, missing or stale Codex review of the head blocks unless the head's codex-review success names the fallback review of that exact commit (`… (Codex at limit) of <sha7>` or `<sha8> passed on Claude self-review`). #417 to #420 already recorded that form.
**Consequence:** every push needs a fresh Codex review (or a fallback naming that push's head) before `make merge`; a codex-review success left from an earlier head no longer carries.

## 2026-10-23 — Scorecard bounds record each check, not a share
**Why:** devkit #218 made the scorecard ratchet hold each check by name; the share-only `{"wired": 1.0}` file bounds no check and fails `scorecard_file` until rewritten.
**Decision:** `scorecard.py . --mode tighten` (the scorecard step of `make metrics-tighten`) rewrote `docs/metrics/scorecard.json` as `{"checks": {<id>: wired}}`; every check the share counted stays wired. Unwired, recorded as backlog: none.
**Consequence:** ci-metrics now fails a recorded wired check that goes unwired, and a backlog check once wired until `make metrics-tighten` records it.

## 2026-10-26 — vitest.config.ts takes the clock shift from devkit's `clockShift()` plugin
**Why:** devkit #227 replaced its setup-files export with the `clockShift()` vite plugin (setup file first in every project's setupFiles, the file allowed past `server.fs.strict`, a no-op unshifted); #228 deprecated the export with a 30-day removal window and devkit-check warns on it.
**Decision:** `plugins: [clockShift()]` on the root config; the root `setupFiles` line that only carried the shift is gone. Vitest stays on 4.0.18 here (fleet target 5, a separate change).
**Consequence:** same runs as before at 0, +30d and +365d: unit 1519, db 4513, the two muse-round-close entries the only clock_shift.conf exceptions.

## 2026-10-26 — The page audit paces the app's rate limits; WebKit's double 401 (#374, #301)
**Why:** the nightly's audit failed `suggest_garment` with a 429: it and `add_garment_from_link` spend one `MCP_LINK_IMPORT_LIMIT` (10 a minute per user), and each had capped its own `runs` to fit alone (18 calls). Per-step caps do not compose once steps share a counter, and the photo choice's limit answers 200, so an over-budget run there would time a refusal unnoticed. The same run expected `/healthz`'s old 204 (an alias of `/health/ready` since #384), and WebKit logged the refused login's 401 twice (the worker's fetch and the document's).
**Decision:** a step declares `limits` (`AuditLimit`, `scripts/audit/budget.ts`: `auditLimit()` over the constant in `rate-limit.ts`, whose windows are now the number 60 000 the plugin parsed '1 minute' to, typed by `satisfies`); one `Budgets` tracker per walk waits before every run until each budget has room (sliding window, so the plugin's fixed one never trips) and logs the wait. `runs` stays a sample count. `/health/live` and `/health/ready` joined #174. `test/auth.spec.ts` asserts every console error is the 401 line, at least once, and awaits the registration's inline check before submitting (a Mac's WebKit logged the cut-off request as `htmx:sendError` 7 runs in 8).
**Consequence:** the walk is slower by about a minute (the MCP link budget). A new limited step that forgets `limits` still 429s, as before; the rule is in `test/AGENTS.md` and `docs/perf/README.md`.

## 2026-10-26 — Tests on vitest 5.0.3 and vite 8.3.4 (fleet target); config is vitest.config.mts
**Why:** fleet target (orbit #127, rollcall #91). Vitest 5 makes `vite` a required peer; vite 8's optional `esbuild` peer (`^0.27 || ^0.28`) refused our direct `esbuild ^0.25` (ERESOLVE), and vite 8 warns that `vitest.config.ts` is ESM in a CommonJS package (vite 7 did not).
**Decision:** exact pins vitest, @vitest/coverage-v8 5.0.3 and vite 8.3.4; `esbuild` `^0.28.2` (vite 7 already ran 0.28 nested; fonts.css, src-sw.js and bundle.css build byte-identical); `@types/node` stays `^22` (peer `^22 || >=24`, .nvmrc 22); no DOM environment to pin. The config is `.mts`, which clears the loader warning without `"type": "module"`. Migration guide checked: no nested `vi.mock`/`vi.hoisted`, no `sequential`, no worker-id use, no unawaited `resolves`/`rejects`; the projects already say `extends: true`, and the clockShift() plugin handles v5's appended setupFiles.
**Consequence:** unit 1519 and db 4513 at 0/+30d/+365d, the same two clock_shift.conf exceptions. Vite 8 transforms with Oxc, whose source maps split single-line `if (…) throw` statements and `??` sort tie-breaks that esbuild's maps folded into covered code: 5 statements and 4 branches, always unexecuted, became visible, so `coverage.backend.lines` 97.46 → 97.45 (metrics-rebaseline; branches 92.46 held). Those paths are the coverage to add next, not a regression.

## 2026-10-26 — Tailwind scans src/ and public/js/ only
**Why:** `@import "tailwindcss"` with no `source()` let Tailwind v4 scan every tracked file, devkit/ and docs/ included, so prose words became classes (devkit-check's warning; rollcall #81's `.shadow`).
**Decision:** `@import "tailwindcss" source("../../src")` plus `@source "../../public/js"`: the views and class helpers, and the client modules' classList/className. No other tracked file names a class at runtime.
**Consequence:** the built bundle.css loses 44 of 734 class selectors and gains none (155.4 → 143.9 kB); each lost one occurs only in docs/, devkit/, CHANGELOG, eslint.config.mjs, test/ or comments (incl. daisyUI's drawer, navbar, validator and react-day-picker blocks). A class used only from a new directory needs an `@source` line here.

## 2026-10-26 — Production advisories cleared: MCP SDK 1.32.2, zod 4, fastify 5.12.7; the MCP element cap
**Why:** OSV reported 4 high and 13 other advisories in locked production packages that landed with no code change (vuln.backend 0/4/17). The MCP SDK's GHSA-46jr-4wx8-v453 fix is an `McpServer` option that is off unless set; zod 3.25 has no fixed 3.x (GHSA-mrhx-c7xc-m3w5 needs 4.6.6).
**Decision:** direct bumps `@modelcontextprotocol/sdk` ^1.32.2, `zod` ^4.6.7 (imports now `'zod'`; the code already used the `zod/v4` API), `hono` ^4.13.14, `fastify` 5.12.7 (still exact); `npm update` for transitive body-parser 1.20.9/2.4.0, qs 6.16.1 (via express 4.22.3), fast-uri, fast-copy. No overrides needed. `/mcp` sets `maxToolInputElements` to `MAX_TOOL_INPUT_ELEMENTS` (10 000, about 5x the largest real call); coverage targets' colours and materials gained the `.max()` every other array input has.
**Consequence:** vuln.backend 0/0/0. The token check runs before the SDK, so both MCP DoS paths were owner-only. Zod 4.5+ visible changes: `z.iso.datetime()` needs seconds (`feedbackUntil` is our own ISO string), string bounds count code points, and tools/list's JSON Schema now carries `.int().min().max()` bounds it used to drop. body-parser is reachable only through express, which closet never mounts.

## 2026-10-26 — A probe asked for mid-flight probes again; offline-writes blocks the worker

**Why:** `offline-writes.spec.ts` failed 9–17 runs in 100 in WebKit (#436), for two reasons. `probe()` handed a call made mid-flight the running probe's promise, so an `offline` event during the page-load heartbeat took its 200 and the app stayed online for 30 s (on a phone too, after a failed request). And once the worker controls the page, WebKit sends `/health/live` through it, past `page.route`.
**Decision:** `probe` is `singleFlight(task)` (`public/js/single-flight.js`): still one probe at a time, but a call while one runs gets one more run after it, shared by every call in that window. The spec runs with `serviceWorkers: 'block'`: it tests `connectivity.js`, which never depends on a worker.
**Consequence:** an outage seen mid-probe costs one extra HEAD, never the 30 s heartbeat. Locally, both fixes together: 0 in 100 runs under 10 workers, twice; either alone still failed. A spec faking the heartbeat with `page.route` blocks the worker (`docs/testing-webkit.md`).

## 2026-10-27 — jscpd from devkit's pin; `make pr` opens PRs on origin
**Why:** devkit #235 gave jscpd one pin (5.4.2, run through `bin/npm_tool.sh`) and deprecates a repo's own `node_modules/.bin/jscpd` until 2026-11-25; closet's devDependency 5.4.0 was that legacy path. devkit #255 added `pr_create.sh` and devkit-check warns while a gate target has no `pr` target.
**Decision:** jscpd leaves package.json and the lock; metrics.conf's `dup` line already had no `--bin`. `pr: ; devkit/bin/pr_create.sh` sits beside `merge`, and docs/workflow.md steps 3 and 6 name `make pr` and `CODEX_FALLBACK=1 make merge`.
**Consequence:** `duplication.repo.clones` 16 and `jscpd_percent` 0.19 on both pins; devkit-check prints ok with no warning.
