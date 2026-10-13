# Decisions

## 2026-10-12 — Per-repo gate policy is a sourced bash plan, not a TOML map
**Why**: finplat, Orbit and locus's `local_gate.sh` shared ~110 identical lines of mechanics, but
their differences were control flow: a drift job whose make arg depends on a PR label, "image
subsumes vite-build", one fixture dir triggering two suites, an area skipped with a note. A
path→job data map would lose checks or grow an interpreter, and bash has no TOML parser.
**Decision**: `bin/local_gate.sh` is the skeleton; each repo sources `scripts/ci/gate_plan.sh`
with scalar config + `gate_plan()` using `job`/`skip`/`changed`/`pr_has_label`/`nothing_to_run`.
**Consequence**: three 200-line copies → one skeleton + three ~60-line plans; drift fixes
(missing-pull-ref fallback, status retry, bash 3.2 guard, flock required) land once for all.

## 2026-10-12 — Vendored as git subtree (squash) with a tree-hash guard, not a submodule
**Why**: every repo in the work loop runs in worktrees (agent worktrees, the gate's detached
worktree, the Mac merge queue's checkout). `git worktree add` does not populate submodules, so
devkit scripts called from Makefiles inside a worktree would be missing; Actions and Docker build
contexts would need `submodules: true` everywhere.
**Decision**: `git subtree add/pull --squash` at `devkit/`; `devkit-sync.sh` records the
upstream tree hash in `.devkit-rev`; `devkit-check.sh` (in `ci-quick`) asserts `HEAD:devkit`
matches, offline.
**Consequence**: plain files everywhere; an in-repo edit to `devkit/` fails quick-check, which
mechanically enforces "nothing lives in only one repo".

## 2026-10-12 — Skeleton and plan are read from the invoking checkout, not the gated tree
**Why**: the merge queues fast-forward the main checkout before each gate, so the gate logic is
main's. Reading the plan from the merged worktree would let a PR disable its own checks.
**Decision**: unchanged from the previous per-repo scripts: `$ROOT` (where the script lives)
supplies skeleton + plan; the merged worktree supplies the Makefile targets.
**Consequence**: a PR that changes `gate_plan.sh` is gated by the OLD plan; its change takes
effect after merge. The owner reviews plan changes by eye, as before.

## 2026-10-13 — Node is declared once in `.nvmrc` and the gate provisions exactly that
**Why**: nothing declared which Node a repo is tested with. CI said 22 in nine places, the Mac
gate ran 25 and failed every vitest suite (Node 25's default Web Storage stub shadows jsdom's,
Orbit #40, locus #91), and finplat's image had been bumped to Node 26 by a bot while tests
ran 22. The fix each repo needs for Node 25 (a storage shim) is separate from this drift.
**Decision**: exact version in `.nvmrc`; workflows use `node-version-file`; the gate skeleton
runs `node_toolchain.sh` (checksum-verified download from nodejs.org, cached per version) and
refuses to run without it; `toolchain_check.sh` in quick CI fails on any disagreeing copy.
**Consequence**: a Dockerfile bump by Renovate/Dependabot fails quick-check until `.nvmrc`
moves too, so the image never runs a Node the suites never saw. Pinned at 22.23.3 (CI's);
bumping is a one-file change per repo that goes through the gate.

## 2026-10-13 — Playwright browsers installed by one devkit call, idempotency left to Playwright
**Why**: Orbit installed browsers on every e2e run; finplat and closet never did locally, so a
`@playwright/test` bump failed the Mac gate ("Executable doesn't exist") until a manual install.
**Decision**: `bin/playwright_browsers.sh` picks the runner from the lockfile, runs under the
`.nvmrc` Node, and calls `playwright install`, which already skips cached revisions. No
`--dry-run` parsing, no cache inspection. `--with-deps` is dropped with a warning on macOS.
**Consequence**: gates, hooks and CI can call it unconditionally with the same flags.

## 2026-10-13 — One throwaway Postgres script, env-driven, tmpfs on by default
**Why**: five near-copies (finplat `test_pg.sh`, Orbit `test-db` + `e2e/run.sh`, locus smoke +
`_bootstrap.py`) shared ~15 lines and differed only in data (image, credentials, port strategy,
network, tmpfs, server args). Two divergences were bugs: Orbit lacked the tmpfs that stops the
18 GB anonymous-volume leak, and its e2e probed the socket, which answers during init before the
server restarts.
**Decision**: `bin/throwaway_pg.sh up|down|url <name>`, all variation via `PG_*` env; `up`'s only
stdout is `PG_PORT=<n>`; readiness is `pg_isready` over TCP with early exit on container death.
**Consequence**: finplat and Orbit adopt now; locus keeps its Python warm-reuse bootstrap (a
deliberate speed choice) and may adopt later; closet uses scratch databases, not containers.

## 2026-10-13 — One boot-and-wait script for image smokes; assertions stay per repo
**Why**: locus, finplat, Orbit and closet each booted their image with ~35 shared lines (names, private network, DB, health poll, log dump, cleanup); finplat lacked the early exit on container death and Orbit lacked tmpfs. What each checks after boot differs entirely.
**Decision**: `bin/boot_image.sh up|down <name>` owns only the boot: `<name>-net`, optional `<name>-pg` via `throwaway_pg.sh`, `<name>-app` on loopback, status-code health poll with early exit, log dump plus teardown on failure, `BASE=<url>` as the only stdout. All variation is `BOOT_*` env; the app's settings live in the caller's env file.
**Consequence**: repos keep their assertions and call `down` from their EXIT trap. BASE is `127.0.0.1`, so CORS origins built on `localhost` must change. Closet's `--network host` shape is not supported and stays as is.

## 2026-10-13 — Fork PRs are refused by the gate unless the plan opts in
**Why**: the skeleton fetches `pull/<n>/head` for any PR; closet is public, so a fork PR would run a stranger's code on the gate box.
**Decision**: `GATE_ALLOW_FORKS=0` by default, settable only from the plan (not the environment); anything but `isCrossRepository=false` fails closed before fetch, posting no status.
**Consequence**: a fork contribution to a public repo is gated by a maintainer re-pushing it to a branch, or by a deliberate plan opt-in.

## 2026-10-13 — docs_check: AGENTS.md canonical, caps that only shrink
**Why**: the 2026-10-12 owner decision (AGENTS.md real, CLAUDE.md symlink) was violated in closet and in finplat's and locus's subdirs; ten docs exceed the 30/16 KB context budgets; closet's checker tested none of this.
**Decision**: one bash guard over `git ls-files -s`; oversize files need an allowlist entry that fails once the file drops below 90% of its cap, so budgets ratchet down.
**Consequence**: landing it needs an initial allowlist per repo; from then on docs cannot grow back.

## 2026-10-13 — Hooks: shared runner and step loop, per-repo step list
**Why**: finplat and closet each had a quiet runner; Orbit and locus had no hooks; finplat's `core.hooksPath` was silently repointed by a tool install on 2026-08-16 and nothing noticed for two months.
**Decision**: `quiet_run.sh` (one line per step, tail on failure), `hook_steps.sh` (conf load, env gate, LFS chain), templates that are a few lines, `hooks_check.sh` in install and gate preflight with `--fix`.
**Consequence**: a repo's hooks are a `scripts/ci/hooks.conf` step list; the runner's UX is identical everywhere; locus must chain `git lfs pre-push` and the template does.

## 2026-10-13 — Metrics gate is a committed-bounds ratchet with a fail-closed rebaseline label
**Why**: finplat's metrics diff was advisory (exit 0, no direction, not in the gate); the settled decision is "never worse than main, never an absolute threshold".
**Decision**: `metrics_ratchet.py check` against `docs/metrics/ratchet.json`; `--tighten` only on main; loosening only via the `metrics-rebaseline` PR label read fail-closed by the gate plan. Collectors stay per repo (layout-specific, one consumer).
**Consequence**: Phase 3 wires `ci-metrics` into each gate plan; snapshots stay report-only.

## 2026-10-13 — Labels and repo settings are fleet operations run from devkit
**Why**: every repo's label set and merge settings had drifted; homelab #67 placed the scripts in homelab, but they are not per-repo files and need no vendoring.
**Decision**: `github/labels.json` + `repos.json` are the source of truth; the two scripts are idempotent `gh api` callers; auto-merge and protection skipped on private free-plan repos.
**Consequence**: run after each new repo and monthly (Phase 4); `--prune` is explicit.

## 2026-10-13 — Renovate preset in devkit, dashboard approval instead of hard ignores
**Why**: finplat's Dependabot ignore lists would, as `enabled: false`, also block security fixes; Dependabot let advisories through its ignores.
**Decision**: ignored update kinds use `dependencyDashboardApproval`; `.nvmrc`, `FROM node` and `engines` share one group so `toolchain_check` never sees a half-bump; automerge off everywhere because Renovate PRs never receive the Mac `local-gate`.
**Consequence**: consumers' `renovate.json` is three lines; callers of the reusable quick-check float on `@main` while the subtree is pinned, an accepted skew for a workflow that only runs `make ci-quick`.

## 2026-10-13 — Python declared once in `.python-version`, checked like Node
**Why**: finplat tested on 3.13 and shipped 3.14; Orbit and locus had no pin file. The owner chose 3.13 everywhere (same precedent as Node 26→22).
**Decision**: `toolchain_check.sh` compares `.python-version` (MAJOR.MINOR) with every `FROM python:`/uv image tag, every `requires-python` lower bound, and `setup-python` steps (`python-version-file`). Dockerfiles one level down are scanned for both languages.
**Consequence**: moving finplat's `backend/.python-version` to the root fails the check until its image returns to 3.13; that is the point.
