# Decisions

Dated decisions, their rationale and the gotchas they carry. Newest first. The older
history lives in `docs/PROJECT_LOG.md`.

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
