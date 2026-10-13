.PHONY: help ci-deps ci-quick ci-unit ci-db ci-e2e ci-image ci-smoke gate devkit-sync devkit-check toolchain-check release-check workflows-check docs-check hooks-check install

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
# builds with sha-<7> itself. ci-smoke asserts /healthz reports it.
CI_BUILD_VERSION ?= dev
SMOKE_PG_CONTAINER ?= closet-smoke-pg

help:
	@echo "make ci-deps          — npm ci (patches applied by postinstall)"
	@echo "make install          — once per checkout or worktree: devkit-check, then point core.hooksPath at .githooks"
	@echo "make ci-quick         — devkit-check, toolchain-check, release-check, workflows-check, docs-check, then check:static"
	@echo "make ci-unit          — the Vitest unit projects; no database"
	@echo "make ci-db            — every Vitest project with the coverage ratchet, on a throwaway Postgres 18"
	@echo "make ci-e2e           — build, then Playwright chromium against a throwaway Postgres 18 (PWA on, PORT random)"
	@echo "make ci-image         — docker build of the production image (CI_IMAGE=$(CI_IMAGE), CI_BUILD_VERSION=$(CI_BUILD_VERSION))"
	@echo "make ci-smoke         — boot CI_IMAGE on a throwaway Postgres 18 (scripts/smoke-image.sh); /healthz must report CI_BUILD_VERSION"
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

ci-unit:
	npm test

# The whole suite, not only the integration project: the coverage thresholds in
# vitest.config.ts are measured over both tiers, so splitting the run would lose the ratchet.
# Each spec file creates its own C-collation scratch database inside this container
# (test/support/scratch-database.ts reads TEST_DATABASE_URL).
ci-db:
	@$(PG) up $(PG_CONTAINER) >/dev/null
	@trap '$(PG) down $(PG_CONTAINER)' EXIT INT TERM; \
	  TEST_DATABASE_URL=$$($(PG) url $(PG_CONTAINER)) || exit 1; \
	  export TEST_DATABASE_URL; \
	  npm run test:cov

# As production: the PWA on, so the service-worker specs run instead of skipping. Web Push
# needs an https: SITE_URL as its VAPID subject (nothing is fetched from it) and a key pair,
# generated per run unless the caller passes one. A random PORT keeps parallel worktrees off
# :3000, where Playwright would otherwise reuse whatever server listens. SEED_SCREENSHOTS:
# test/screenshots.spec.ts seeds the personas and saves 390 px shots into screenshots/.
ci-e2e:
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
	    CI=true PWA_ENABLED=true SITE_URL=https://closet.test SEED_SCREENSHOTS=1 \
	    ACCESS_TOKEN_SECRET=ci-only-access-token-secret-not-for-deployment \
	    DATABASE_HOST=127.0.0.1 DATABASE_PORT=$$port DATABASE_USER=ci DATABASE_PASS=ci DATABASE_SCHEMA=ci \
	    PORT=$${PORT:-$$(awk 'BEGIN { srand(); print 3200 + int(rand() * 600) }')}; \
	  echo "ci-e2e: app on :$$PORT, Postgres $(PG_CONTAINER) on :$$port"; \
	  npx playwright test --project=chromium

# The image's own boot (health, migrations, SIGTERM) is scripts/smoke-image.sh, run by ci.yml's
# publish job on the exact bytes it pushes; this target proves the Dockerfile still builds.
ci-image:
	docker build --build-arg APP_VERSION=$(CI_BUILD_VERSION) -t $(CI_IMAGE) .

# The publish job's smoke test, locally: CI_IMAGE (build it with ci-image first) on the host
# network against a throwaway Postgres 18 published on loopback, and /healthz must name
# CI_BUILD_VERSION. A random SMOKE_PORT keeps parallel runs off each other.
ci-smoke:
	@port=$$($(PG) up $(SMOKE_PG_CONTAINER) | sed -n 's/^PG_PORT=//p'); \
	  trap '$(PG) down $(SMOKE_PG_CONTAINER)' EXIT INT TERM; \
	  [ -n "$$port" ] || exit 1; \
	  DATABASE_HOST=127.0.0.1 DATABASE_PORT=$$port DATABASE_USER=ci DATABASE_PASS=ci DATABASE_SCHEMA=ci \
	    SMOKE_PORT=$${SMOKE_PORT:-$$(awk 'BEGIN { srand(); print 3800 + int(rand() * 600) }')} \
	    BOOT_EXPECT_VERSION=$(CI_BUILD_VERSION) scripts/smoke-image.sh $(CI_IMAGE)

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
