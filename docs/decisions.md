# Decisions

Dated decisions, their rationale and the gotchas they carry. Newest first. The older
history lives in `docs/PROJECT_LOG.md`.

## 2026-10-13 — Release identity: APP_VERSION baked into the image, ship tags from CI

**Why:** the image named its build three ways (a full sha in `public/build.json` for the error tracker, package.json's frozen `0.5.1` on /about and MCP, semver tags from `tag-release.yml`), and `/healthz` named none, so nothing said which build production runs.
**Decision:** one string, `sha-<7>`: `ci.yml`'s publish job passes `APP_VERSION` once; the Dockerfile's final stage holds `ARG`/`ENV`/`LABEL org.opencontainers.image.version`; `/healthz` answers 200 `{status, version}`; compose never sets it (`make release-check`). Only that job moves `latest`, then tags `ship-<date>-<sha7>`. `tag-release.yml`, the `v*` trigger, semver and date image tags are retired. The Dockerfile moved to the root (devkit's checks read only that one). Renovate replaces Dependabot.
**Consequence:** the error tracker's releases change from full shas to `sha-<7>`. The beacon accepts any `[A-Za-z0-9._-]` release. The builder stage no longer takes the commit, so `npm run build` stays cached across commits.

## 2026-10-13 — PR gate moves in-repo via devkit; strict protection off

**Why:** the gate was a closet-only script outside the repo, posting three per-job statuses, updating branches for strict protection and merging on its own. Its scratch databases lived on the shared pgvault-dev. Its path map also sent `test/support/**` to the browser job only, skipping the integration tier that imports it.
**Decision:** devkit's shared skeleton (`make gate PR=<n>`) runs this repo's Makefile `ci-*` targets from `scripts/ci/gate_plan.sh` and posts one `local-gate`. Protection requires `local-gate` + `codex-review` with strict off. The merge queue merges only when the head and `main` it gated are still current, pinned with `--match-head-commit`. That is the guarantee strict gave, without update-branch or carrying `codex-review` over. Tests run on a throwaway Postgres 18 container (`devkit/bin/throwaway_pg.sh`), never pgvault-dev. Fork PRs are refused (public repo; `GATE_ALLOW_FORKS` stays 0).
**Consequence:** a hand merge in the UI can use a `local-gate` from an older `main`; its description names that `main` ("Passed on main abc1234"). Coordinators never enable auto-merge. A check changes in the Makefile, never in the plan or `ci.yml`.
