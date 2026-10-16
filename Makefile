.PHONY: help ci-deps ci-quick ci-unit ci-db ci-e2e ci-image ci-smoke ci-metrics metrics-snapshot metrics-tighten screenshots gate devkit-sync devkit-check toolchain-check release-check workflows-check docs-check hooks-check install

# Thin callers: the npm scripts in package.json stay the definitions of each check. These
# targets add only what a clean machine needs around them (a throwaway Postgres, browsers,
# e2e env), so the PR gate (scripts/ci/gate_plan.sh) and ci.yml run the same thing.
# Run `make ci-deps` once first; the other ci-* targets assume node_modules.

PG := devkit/bin/throwaway_pg.sh
# One container name per caller; the gate passes closet-gate-pg-<pr> and removes it on exit.
# ci-db and ci-e2e each bring it up fresh and take it down, so they never share data.
PG_CONTAINER ?= closet-ci-pg
# --with-deps on Linux runners (system libraries); ignored on macOS.
PLAYWRIGHT_FLAGS ?=
CI_IMAGE ?= closet:ci
# The image's APP_VERSION (Dockerfile ARG): the gate passes gate-<pr>, ci.yml's publish job
# builds with the bare 7-char sha itself. ci-smoke asserts /health/ready reports it.
CI_BUILD_VERSION ?= dev
SMOKE_PG_CONTAINER ?= closet-smoke-pg

# Test-tier budgets and floors (owner directive 2026-10-13, docs/decisions.md "Lean test suite"):
# devkit's tier guard fails a tier over its wall-clock budget (TIER_BUDGET_ENFORCE=0 only
# reports) or one that ran fewer tests than the floor (a lost glob passes green otherwise),
# counting the runner's own summary line: tests that ran, never skipped ones. It prints one
# `TIER <tier>` line and writes build/metrics/tier-<tier>.json. The floors are the counts at the
# last change to the suite: raise them with new tests; lower them only in the PR that removes
# tests, saying why.
TIER := devkit/bin/tier_guard.sh
UNIT_BUDGET_SECONDS := 60
# db: 110 s, about twice its worst gate-like run (56 s beside e2e and an uncached image build;
# 51 s in PR #387's gate). docs/decisions.md 2026-10-14.
DB_BUDGET_SECONDS := 110
E2E_BUDGET_SECONDS := 180
UNIT_FLOOR := 1486
DB_FLOOR := 4472
E2E_FLOOR := 10

help:
	@echo "make ci-deps          — npm ci (patches applied by postinstall)"
	@echo "make install          — once per checkout or worktree: devkit-check, then point core.hooksPath at .githooks"
	@echo "make ci-quick         — devkit-check, toolchain-check, release-check, workflows-check, docs-check, then check:static"
	@echo "make ci-unit          — the Vitest unit projects; no database. Budget $(UNIT_BUDGET_SECONDS) s, floor $(UNIT_FLOOR) tests"
	@echo "make ci-db            — every Vitest project with the coverage ratchet, on a throwaway Postgres 18. Budget $(DB_BUDGET_SECONDS) s, floor $(DB_FLOOR)"
	@echo "make ci-e2e           — build, then Playwright chromium against a throwaway Postgres 18 (PWA on, PORT random). Budget $(E2E_BUDGET_SECONDS) s, floor $(E2E_FLOOR)"
	@echo "make screenshots      — the 390 px persona screenshots (test/screenshots.spec.ts) into screenshots/, same server as ci-e2e"
	@echo "make ci-image         — docker build of the production image (CI_IMAGE=$(CI_IMAGE), CI_BUILD_VERSION=$(CI_BUILD_VERSION))"
	@echo "make ci-smoke         — boot CI_IMAGE on a throwaway Postgres 18 (scripts/smoke-image.sh); /health/ready must report CI_BUILD_VERSION"
	@echo "make ci-metrics       — the metrics ratchet: scripts/ci/metrics.conf's collectors against docs/metrics/ratchet.json (the gate's last job)"
	@echo "make metrics-snapshot — run the collectors; build/metrics.json is the report"
	@echo "make metrics-tighten  — lock in improved numbers; commit docs/metrics/ratchet.json in the same PR"
	@echo "make gate PR=<n>      — the PR gate: these jobs on PR <n> merged into origin/main [GATE_ARGS=--no-post]"
	@echo "make devkit-sync      — pull the latest agandhi4/devkit into devkit/ and record it in .devkit-rev"
	@echo "make devkit-check     — fail if devkit/ differs from .devkit-rev (part of ci-quick)"
	@echo "make toolchain-check  — fail if a Dockerfile or workflow disagrees with the Node in .nvmrc (part of ci-quick)"
	@echo "make release-check    — fail unless the image is APP_VERSION's only source (part of ci-quick)"
	@echo "make workflows-check  — fail unless the workflows follow devkit's Actions rules (part of ci-quick)"
	@echo "make docs-check       — AGENTS.md real + CLAUDE.md symlink, size caps, the area index (part of ci-quick)"
	@echo "make hooks-check      — fail unless core.hooksPath is .githooks and both hooks are executable"

ci-deps:
	npm ci --no-audit --no-fund

ci-quick: devkit-check toolchain-check release-check workflows-check docs-check
	npm run check:static

# The floors read the default and list reporters' summary lines: keep those reporters.
ci-unit:
	$(TIER) unit --budget $(UNIT_BUDGET_SECONDS) --floor vitest=$(UNIT_FLOOR) -- npm test

# The whole suite, not only the integration project: the coverage thresholds in
# vitest.config.ts are measured over both tiers, so splitting the run would lose the ratchet.
# Each spec file clones the migrated template inside this container (migrations once per run;
# test/support/scratch-database.ts reads TEST_DATABASE_URL). STATEMENTS_OUT: the statement
# counts the specs pin (recordQueries), as the metrics ratchet's `statements.*` keys
# (test/support/statement-budgets.ts; devkit docs/metrics-keys.md).
ci-db:
	@$(PG) up $(PG_CONTAINER) >/dev/null
	@trap '$(PG) down $(PG_CONTAINER)' EXIT INT TERM; \
	  TEST_DATABASE_URL=$$($(PG) url $(PG_CONTAINER)) || exit 1; \
	  export TEST_DATABASE_URL STATEMENTS_OUT=build/metrics/statements.json; \
	  $(TIER) db --budget $(DB_BUDGET_SECONDS) --floor vitest=$(DB_FLOOR) -- npm run test:cov

# As production: the PWA on, so the service-worker specs run instead of skipping. Web Push
# needs an https: SITE_URL as its VAPID subject (nothing is fetched from it) and a key pair,
# generated per run unless the caller passes one. A random PORT keeps parallel worktrees off
# :3000, where Playwright would otherwise reuse whatever server listens. The Playwright run
# alone is budgeted (the build is the job budget's, devkit local_gate.sh). $(1) is the
# Playwright command, $(2) the target's name for the log line; `screenshots` reuses it.
define e2e_server
	devkit/bin/playwright_browsers.sh $(PLAYWRIGHT_FLAGS) chromium
	npm run build
	@port=$$($(PG) up $(PG_CONTAINER) | sed -n 's/^PG_PORT=//p'); \
	  trap '$(PG) down $(PG_CONTAINER)' EXIT INT TERM; \
	  [ -n "$$port" ] || exit 1; \
	  if [ -z "$${PUBLIC_VAPID_KEY:-}" ]; then \
	    keys=$$(node -e "const k = require('web-push').generateVAPIDKeys(); console.log(k.publicKey, k.privateKey)") || exit 1; \
	    PUBLIC_VAPID_KEY=$${keys% *}; PRIVATE_VAPID_KEY=$${keys#* }; \
	  fi; \
	  export PUBLIC_VAPID_KEY PRIVATE_VAPID_KEY \
	    CI=true APP_ENV=gate PWA_ENABLED=true SITE_URL=https://closet.test \
	    ACCESS_TOKEN_SECRET=ci-only-access-token-secret-not-for-deployment \
	    DATABASE_HOST=127.0.0.1 DATABASE_PORT=$$port DATABASE_USER=ci DATABASE_PASS=ci DATABASE_SCHEMA=ci \
	    PORT=$${PORT:-$$(awk 'BEGIN { srand(); print 3200 + int(rand() * 600) }')}; \
	  echo "$(2): app on :$$PORT, Postgres $(PG_CONTAINER) on :$$port"; \
	  $(1)
endef

ci-e2e:
	$(call e2e_server,$(TIER) e2e --budget $(E2E_BUDGET_SECONDS) --floor playwright=$(E2E_FLOOR) -- npx playwright test --project=chromium --reporter=list,ci-e2e)

# Not a gate: 390 px screenshots of the seed personas into screenshots/ (ci.yml's e2e job uploads
# them). test/screenshots.spec.ts runs only with SEED_SCREENSHOTS, which playwright.config.ts
# otherwise ignores the file under.
screenshots:
	$(call e2e_server,SEED_SCREENSHOTS=1 npx playwright test test/screenshots.spec.ts --project=chromium,screenshots)

# The image's own boot (health, migrations, SIGTERM) is scripts/smoke-image.sh, run by ci.yml's
# publish job on the exact bytes it pushes; this target proves the Dockerfile still builds.
ci-image:
	docker build --build-arg APP_VERSION=$(CI_BUILD_VERSION) -t $(CI_IMAGE) .

# The publish job's smoke test, locally: CI_IMAGE (build it with ci-image first) on the host
# network against a throwaway Postgres 18 published on loopback, and /health/ready must name
# CI_BUILD_VERSION. A random SMOKE_PORT keeps parallel runs off each other.
ci-smoke:
	@port=$$($(PG) up $(SMOKE_PG_CONTAINER) | sed -n 's/^PG_PORT=//p'); \
	  trap '$(PG) down $(SMOKE_PG_CONTAINER)' EXIT INT TERM; \
	  [ -n "$$port" ] || exit 1; \
	  DATABASE_HOST=127.0.0.1 DATABASE_PORT=$$port DATABASE_USER=ci DATABASE_PASS=ci DATABASE_SCHEMA=ci \
	    SMOKE_PORT=$${SMOKE_PORT:-$$(awk 'BEGIN { srand(); print 3800 + int(rand() * 600) }')} \
	    BOOT_EXPECT_VERSION=$(CI_BUILD_VERSION) scripts/smoke-image.sh $(CI_IMAGE)

# Metrics ratchet (devkit README "Metrics ratchet"): devkit/bin/metrics_collect.sh owns which
# collectors run, the merge and the comparison with main's bounds. Needs node_modules (ci-deps)
# and origin/main fetched.
ci-metrics:
	devkit/bin/metrics_collect.sh check

metrics-snapshot:
	devkit/bin/metrics_collect.sh snapshot

metrics-tighten:
	devkit/bin/metrics_collect.sh tighten

gate:
	@test -n "$(PR)" || { echo "usage: make gate PR=<number> [GATE_ARGS=--no-post]" >&2; exit 2; }
	devkit/bin/local_gate.sh "$(PR)" $(GATE_ARGS)

devkit-sync:
	devkit/bin/devkit-sync.sh

devkit-check:
	devkit/bin/devkit-check.sh

toolchain-check:
	devkit/bin/toolchain_check.sh

release-check:
	devkit/bin/release_check.sh

workflows-check:
	devkit/bin/workflows_check.sh

# Devkit's rules, plus closet's area index (scripts/ci/docs_rules.sh). Caps allowlist, if one is
# ever needed: scripts/ci/docs_oversize.txt.
docs-check:
	devkit/bin/docs_check.sh

hooks-check:
	devkit/bin/hooks_check.sh

# Steps: scripts/ci/hooks.conf. --fix rewrites core.hooksPath, so a tool that repointed it is
# undone by the next install.
install: devkit-check
	devkit/bin/hooks_check.sh --fix
