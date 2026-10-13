#!/usr/bin/env bats
# shellcheck shell=bash
# shellcheck disable=SC2030,SC2031  # each @test is its own subshell by design; nothing leaks between tests
# Contract tests for bin/devkit-new.sh: a generated repo passes every devkit guard on its first
# commit, and that commit went through the hooks. Offline and fast: the upstream to vendor is a
# throwaway full repo holding this checkout's HEAD tree (so the PR's own scripts are what the
# repo runs; not the checkout itself, which is a shallow clone in Actions and git refuses to
# fetch a shallow root into another repo), and the stack tools (uv, npm, cargo) are PATH stubs
# that log their calls and install nothing. The fake cargo reports the rust stack's pinned
# version, so rust_toolchain.sh finds PATH's cargo matching and never downloads.
# The guards (devkit-check, toolchain-check, docs-check, release-check, workflows-check,
# own-commit-check, hooks-check) and make are real.

DEVKIT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
NEW="$DEVKIT/bin/devkit-new.sh"

bats_require_minimum_version 1.5.0  # run !

setup() {
  TMP=$(mktemp -d "${BATS_TEST_TMPDIR:-${TMPDIR:-/tmp}}/new.XXXXXX")
  export TMPDIR=$TMP
  BIN=$TMP/bin
  mkdir -p "$BIN"
  export PATH=$BIN:$PATH
  export DEVKIT_URL=$TMP/upstream DEVKIT_REF=main FAKE_LOG=$TMP/tools.log
  # hooks_check.sh is a no-op under CI; the generated repo's hooks are the point here.
  unset CI GITHUB_ACTIONS
  export GIT_CONFIG_GLOBAL=$TMP/gitconfig GIT_CONFIG_NOSYSTEM=1
  git config --file "$GIT_CONFIG_GLOBAL" user.name new-test
  git config --file "$GIT_CONFIG_GLOBAL" user.email new-test@local
  : >"$FAKE_LOG"
  fake_tool uv
  fake_tool npm
  fake_tool cargo
  FAKE_CARGO_VERSION=$("$DEVKIT/bin/rust_toolchain.sh" --declared "$DEVKIT/templates/new/stacks/rust")
  export FAKE_CARGO_VERSION
  mkdir "$DEVKIT_URL"
  git -C "$DEVKIT" archive HEAD | tar -x -C "$DEVKIT_URL"
  git init -q -b main "$DEVKIT_URL"
  git -C "$DEVKIT_URL" add -A
  git -C "$DEVKIT_URL" commit -q -m "devkit HEAD tree"
  UPSTREAM_SHA=$(git -C "$DEVKIT_URL" rev-parse HEAD)
  UPSTREAM_SHA7=${UPSTREAM_SHA:0:7}
}

teardown() {
  rm -rf "$TMP"
}

# A stack tool that records its arguments and succeeds; the lock commands leave the lockfile a
# real run would, so the Makefile sees the same tree.
fake_tool() {
  cat >"$BIN/$1" <<'SH'
#!/usr/bin/env bash
echo "$(basename "$0") $*" >>"$FAKE_LOG"
case "$(basename "$0") $* " in
  "npm install --package-lock-only "*) echo '{"lockfileVersion": 3}' >package-lock.json ;;
  "cargo generate-lockfile "*) echo 'version = 4' >Cargo.lock ;;
  "cargo --version ") echo "cargo $FAKE_CARGO_VERSION (fake)" ;;
esac
SH
  chmod +x "$BIN/$1"
}

generate() { # <name> <stack> [flags...]
  local name=$1 stack=$2
  shift 2
  run "$NEW" "$name" --stack "$stack" --dir "$TMP" "$@"
  echo "$output"
  [ "$status" -eq 0 ]
  REPO=$TMP/$name
}

assert_guards_pass() { # [targets...]
  local t
  for t in "$@"; do
    run make -C "$REPO" --no-print-directory "$t"
    echo "--- $t: $output"
    [ "$status" -eq 0 ]
  done
}

@test "python-fastapi: one commit through the hooks, every guard and ci-quick pass" {
  generate app python-fastapi
  # Exactly one commit, holding the scaffold and the vendored devkit together.
  [ "$(git -C "$REPO" rev-list --count HEAD)" -eq 1 ]
  [[ "$(git -C "$REPO" log -1 --format=%s)" == "Create app with devkit new (python-fastapi, devkit "* ]]
  [ -z "$(git -C "$REPO" status --porcelain)" ]
  [ "$(git -C "$REPO" config core.hooksPath)" = .githooks ]
  # The commit ran pre-commit, which ran ci-quick: the stack's lint went through the stub.
  grep -q '^uv lock$' "$FAKE_LOG"
  grep -q '^uv sync --frozen$' "$FAKE_LOG"
  grep -q '^uv run ruff check server tests$' "$FAKE_LOG"
  # What was vendored is what .devkit-rev records, and it is this checkout's HEAD tree.
  read -r rev tree <"$REPO/.devkit-rev"
  [ "$rev" = "$UPSTREAM_SHA" ]
  [ "$tree" = "$(git -C "$DEVKIT" rev-parse 'HEAD^{tree}')" ]
  [ "$(git -C "$REPO" rev-parse HEAD:devkit)" = "$tree" ]
  assert_guards_pass devkit-check toolchain-check docs-check hooks-check release-check workflows-check own-commit-check ci-quick
  [[ "$output" == *"devkit-check: ok"* ]]
}

@test "python-fastapi: the generated files are the standard shape" {
  generate app python-fastapi
  [ -L "$REPO/CLAUDE.md" ] && [ "$(readlink "$REPO/CLAUDE.md")" = AGENTS.md ]
  [ "$(wc -c <"$REPO/AGENTS.md")" -le 8192 ]
  grep -q '^Conventions: delivery.md, data.md, observability.md, backend.md, backend-fastapi.md$' "$REPO/AGENTS.md"
  grep -q 'ORCHESTRATION-OVERRIDE' "$REPO/AGENTS.md"
  run ! grep -qE '__(NAME|DATE|DEVKIT_SHA7|STACK|CONVENTIONS|PINS|STUBS)__|^#@' "$REPO/AGENTS.md"
  grep -q "Created by \`devkit new\` (devkit $UPSTREAM_SHA7)" "$REPO/docs/decisions.md"
  [ "$(cat "$REPO/.python-version")" = 3.13 ]
  [ ! -e "$REPO/.nvmrc" ]
  cmp -s "$DEVKIT/templates/workflows/quick-check-caller.yml" "$REPO/.github/workflows/quick-check.yml"
  grep -q 'cancel-in-progress: false' "$REPO/.github/workflows/publish.yml"
  grep -q 'ship_tag.sh' "$REPO/.github/workflows/publish.yml"
  grep -q 'extend = "devkit/lint/ruff.toml"' "$REPO/pyproject.toml"
  [ "$(jq -r '.extends[0]' "$REPO/renovate.json")" = "github>agandhi4/devkit//renovate/default" ]
  jq -e '.enabledPlugins["core@claude-kit"]' "$REPO/.claude/settings.json" >/dev/null
  cmp -s "$DEVKIT/templates/githooks/pre-commit" "$REPO/.githooks/pre-commit"
  cmp -s "$DEVKIT/templates/githooks/pre-push" "$REPO/.githooks/pre-push"
  [ -x "$REPO/scripts/ci/smoke_image.sh" ]
  # No template marker or placeholder survives anywhere in the tracked tree.
  run git -C "$REPO" grep -lE '__NAME__|^#@(image|no-image|end)$' -- . ':!devkit'
  [ "$status" -eq 1 ]
  # The gate plan satisfies the skeleton's contract.
  # shellcheck disable=SC1091  # the generated plan; $PR is what the skeleton exports before sourcing
  ( cd "$REPO" && export PR=7 && . scripts/ci/gate_plan.sh && [ "$GATE_SLUG" = agandhi4/app ] && [ "$GATE_STATE_NAME" = app-gate ] && declare -F gate_plan >/dev/null && declare -F gate_cleanup >/dev/null )
}

@test "python-fastapi: stub tiers exit 2 and say so" {
  generate app python-fastapi
  run make -C "$REPO" --no-print-directory ci-e2e
  [ "$status" -eq 2 ]
  [[ "$output" == *"ci-e2e: app has no browser tier yet"* ]]
  run make -C "$REPO" --no-print-directory ci-metrics
  [ "$status" -eq 2 ]
  [[ "$output" == *"no metrics collector yet"* ]]
}

@test "node-service: one commit through the hooks, every guard and ci-quick pass" {
  generate svc node-service
  [ "$(git -C "$REPO" rev-list --count HEAD)" -eq 1 ]
  [ "$(git -C "$REPO" config core.hooksPath)" = .githooks ]
  [ -z "$(git -C "$REPO" status --porcelain)" ]
  grep -q '^npm install --package-lock-only' "$FAKE_LOG"
  grep -q '^npm ci --no-audit --no-fund$' "$FAKE_LOG"
  grep -q '^npm run lint$' "$FAKE_LOG"
  git -C "$REPO" ls-files --error-unmatch package-lock.json >/dev/null
  [ "$(cat "$REPO/.nvmrc")" = 22.23.3 ]
  grep -q '^FROM node:22-slim$' "$REPO/Dockerfile"
  # The stack's .gitignore is appended to the common one, not a replacement for it.
  grep -qx 'node_modules/' "$REPO/.gitignore" && grep -qx '.env' "$REPO/.gitignore"
  grep -q '^Conventions: delivery.md, data.md, observability.md, backend.md$' "$REPO/AGENTS.md"
  assert_guards_pass devkit-check toolchain-check docs-check hooks-check release-check workflows-check ci-quick
  run make -C "$REPO" --no-print-directory ci-db
  [ "$status" -eq 2 ]
  [[ "$output" == *"no database tier yet"* ]]
}

@test "--no-image: no Dockerfile, publish workflow or smoke; image targets are stubs; guards still pass" {
  generate svc node-service --no-image
  for f in Dockerfile .dockerignore scripts/ci/smoke_image.sh .github/workflows/publish.yml; do
    [ ! -e "$REPO/$f" ]
  done
  run make -C "$REPO" --no-print-directory ci-image
  [ "$status" -eq 2 ]
  [[ "$output" == *"publishes no image"* ]]
  run make -C "$REPO" --no-print-directory release-check
  [ "$status" -eq 0 ]
  [[ "$output" == *"no Dockerfile; nothing to check"* ]]
  grep -q 'skip image "no image is published' "$REPO/scripts/ci/gate_plan.sh"
  run ! grep -q 'IMAGE_PATHS' "$REPO/scripts/ci/gate_plan.sh"
  grep -q 'No image is published' "$REPO/AGENTS.md"
  run ! grep -q 'ship_tag' "$REPO/AGENTS.md"
  assert_guards_pass docs-check hooks-check workflows-check ci-quick
}

@test "rust: one commit through the hooks, every guard, ci-quick and ci-unit pass" {
  generate svc rust
  [ "$(git -C "$REPO" rev-list --count HEAD)" -eq 1 ]
  [ "$(git -C "$REPO" config core.hooksPath)" = .githooks ]
  [ -z "$(git -C "$REPO" status --porcelain)" ]
  # The lock step and the hook's ci-quick both went through scripts/ci/cargo.sh to the stub.
  grep -q '^cargo generate-lockfile$' "$FAKE_LOG"
  grep -q '^cargo fmt --all -- --check$' "$FAKE_LOG"
  grep -q '^cargo clippy --locked --all-targets -- -D warnings$' "$FAKE_LOG"
  git -C "$REPO" ls-files --error-unmatch Cargo.lock >/dev/null
  [ "$("$DEVKIT/bin/rust_toolchain.sh" --declared "$REPO")" = "$FAKE_CARGO_VERSION" ]
  grep -qx "FROM rust:${FAKE_CARGO_VERSION%.*}-alpine AS build" "$REPO/Dockerfile"
  grep -q '^name = "svc"$' "$REPO/Cargo.toml"
  grep -q '^Conventions: delivery.md, observability.md, backend.md$' "$REPO/AGENTS.md"
  grep -qx '/target/' "$REPO/.gitignore" && grep -qx '.env' "$REPO/.gitignore"
  [ -x "$REPO/scripts/ci/cargo.sh" ] && [ -x "$REPO/scripts/ci/smoke_image.sh" ]
  grep -q 'ship_tag.sh' "$REPO/.github/workflows/publish.yml"
  assert_guards_pass devkit-check toolchain-check docs-check hooks-check release-check workflows-check ci-quick ci-unit
  grep -q '^cargo test --locked$' "$FAKE_LOG"
  run git -C "$REPO" grep -lE '__NAME__|^#@(image|no-image|end)$' -- . ':!devkit'
  [ "$status" -eq 1 ]
  # shellcheck disable=SC1091  # the generated plan; $PR is what the skeleton exports before sourcing
  ( cd "$REPO" && export PR=7 && . scripts/ci/gate_plan.sh && [ "$GATE_SLUG" = agandhi4/svc ] && declare -F gate_plan >/dev/null && declare -F gate_cleanup >/dev/null )
  for t in ci-db ci-e2e ci-metrics; do
    run make -C "$REPO" --no-print-directory "$t"
    [ "$status" -eq 2 ]
    [[ "$output" == *"$t: svc has no "* ]]
  done
}

@test "rust --no-image: no Dockerfile, publish workflow or smoke; guards still pass" {
  generate svc rust --no-image
  for f in Dockerfile .dockerignore scripts/ci/smoke_image.sh .github/workflows/publish.yml; do
    [ ! -e "$REPO/$f" ]
  done
  [ -x "$REPO/scripts/ci/cargo.sh" ]
  run make -C "$REPO" --no-print-directory ci-smoke
  [ "$status" -eq 2 ]
  [[ "$output" == *"publishes no image"* ]]
  grep -q 'skip image "no image is published' "$REPO/scripts/ci/gate_plan.sh"
  assert_guards_pass toolchain-check release-check workflows-check ci-quick
}

@test "next-vercel: image-less by stack, one commit through the hooks, guards, ci-quick and drift" {
  generate web next-vercel
  # STACK_IMAGE=0: --no-image is implied, never asked for.
  [[ "$output" == *"--no-image is implied"* ]]
  [[ "$output" == *"image=0"* ]]
  [ "$(git -C "$REPO" rev-list --count HEAD)" -eq 1 ]
  [ -z "$(git -C "$REPO" status --porcelain)" ]
  for f in Dockerfile .github/workflows/publish.yml; do [ ! -e "$REPO/$f" ]; done
  grep -q '^npm install --package-lock-only' "$FAKE_LOG"
  for script in typegen typecheck lint db:generate; do grep -qx "npm run $script" "$FAKE_LOG"; done
  [ "$(cat "$REPO/.nvmrc")" = 24.21.0 ]
  [ "$(jq -r .engines.node "$REPO/package.json")" = 24.x ]
  grep -q '^Conventions: delivery.md, data.md, observability.md, frontend.md, frontend-react.md$' "$REPO/AGENTS.md"
  grep -qF "No image is published (Vercel builds and deploys it from" "$REPO/AGENTS.md"
  run ! grep -q 'devkit new --no-image' "$REPO/AGENTS.md"
  grep -qx 'node_modules/' "$REPO/.gitignore" && grep -qx '.next/' "$REPO/.gitignore" && grep -qx '.env' "$REPO/.gitignore"
  git -C "$REPO" ls-files --error-unmatch drizzle/meta/_journal.json >/dev/null
  run git -C "$REPO" grep -lE '__[A-Z_]+__|^#@(image|no-image|end)$' -- . ':!devkit'
  [ "$status" -eq 1 ]
  assert_guards_pass devkit-check toolchain-check docs-check hooks-check release-check workflows-check ci-quick ci-unit ci-drift
  grep -qx 'npm test' "$FAKE_LOG"
  # shellcheck disable=SC1091  # the generated plan; $PR is what the skeleton exports before sourcing
  ( cd "$REPO" && export PR=7 && . scripts/ci/gate_plan.sh && [ "$GATE_SLUG" = agandhi4/web ] && [ "$PG_CONTAINER" = web-gate-7-pg ] && declare -F gate_plan >/dev/null && declare -F gate_cleanup >/dev/null )
  for t in ci-image ci-smoke; do
    run make -C "$REPO" --no-print-directory "$t"
    [ "$status" -eq 2 ]
    [[ "$output" == *"Vercel builds it"* ]]
  done
  run make -C "$REPO" --no-print-directory ci-metrics
  [ "$status" -eq 2 ]
  # Drift: a migration drizzle-kit wrote but nobody committed fails; staged with its schema
  # change (the pre-commit case) it passes.
  echo 'CREATE TABLE t ();' >"$REPO/drizzle/0000_new.sql"
  run make -C "$REPO" --no-print-directory ci-drift
  [ "$status" -ne 0 ]
  [[ "$output" == *"drizzle/ does not match src/db/schema.ts"* ]]
  git -C "$REPO" add drizzle/0000_new.sql
  assert_guards_pass ci-drift
}

@test "usage: unknown stack lists the stacks, a bad name and an existing directory are refused" {
  run "$NEW" app --stack cobol --dir "$TMP"
  [ "$status" -eq 2 ]
  [[ "$output" == *"unknown stack 'cobol'"* ]]
  [[ "$output" == *"python-fastapi"* ]] && [[ "$output" == *"node-service"* ]]
  [[ "$output" == *"rust"* ]] && [[ "$output" == *"next-vercel"* ]]
  run "$NEW" App --stack node-service --dir "$TMP"
  [ "$status" -eq 1 ]
  [[ "$output" == *"lowercase"* ]]
  mkdir "$TMP/taken"
  run "$NEW" taken --stack node-service --dir "$TMP"
  [ "$status" -eq 1 ]
  [[ "$output" == *"already exists"* ]]
  run "$NEW" --list
  [ "$status" -eq 0 ]
  [ "${#lines[@]}" -eq 4 ]
}

@test "a missing stack tool fails before anything is written" {
  rm "$BIN/uv"
  run env PATH="$BIN:/usr/bin:/bin" "$NEW" app --stack python-fastapi --dir "$TMP"
  [ "$status" -eq 2 ]
  [[ "$output" == *"'uv' not found"* ]]
  [ ! -e "$TMP/app" ]
}
