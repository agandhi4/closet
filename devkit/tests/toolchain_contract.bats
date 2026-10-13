#!/usr/bin/env bats
# shellcheck shell=bash
# shellcheck disable=SC2030,SC2031  # each @test is its own subshell by design; nothing leaks between tests
# Contract tests for bin/node_toolchain.sh and bin/toolchain_check.sh. No network: every test
# sets DEVKIT_OFFLINE=1, and "installed" Nodes are executable stubs under $XDG_DATA_HOME that
# only answer --version. A fake PATH node (fake_path_node) stands in for the machine's node.

NODE_TOOLCHAIN="$BATS_TEST_DIRNAME/../bin/node_toolchain.sh"
TOOLCHAIN_CHECK="$BATS_TEST_DIRNAME/../bin/toolchain_check.sh"
WANTED=22.23.3
PY_WANTED=3.13

setup() {
  TMP=$(mktemp -d "${BATS_TEST_TMPDIR:-${TMPDIR:-/tmp}}/toolchain.XXXXXX")
  REPO=$TMP/repo
  BIN=$TMP/bin
  export XDG_DATA_HOME=$TMP/data
  export DEVKIT_OFFLINE=1
  export PATH=$BIN:$PATH
  STORE=$XDG_DATA_HOME/devkit/node
  mkdir -p "$REPO" "$BIN"
  # The PATH node differs from .nvmrc unless a test says otherwise (the Mac-runs-25 situation).
  fake_path_node 25.0.0
}

teardown() {
  rm -rf "$TMP"
}

write_node_stub() { # <path> <version>
  mkdir -p "$(dirname "$1")"
  printf '#!/bin/sh\necho v%s\n' "$2" >"$1"
  chmod +x "$1"
}
fake_path_node() { write_node_stub "$BIN/node" "$1"; }
cache_node() { write_node_stub "$STORE/v$1/bin/node" "$1"; }

# A consumer repo for toolchain_check: .nvmrc, Dockerfile, one workflow. Each test overwrites
# the pieces it is about.
make_repo() {
  git init -q "$REPO"
  printf '%s\n' "$WANTED" >"$REPO/.nvmrc"
  printf 'FROM node:22-alpine@sha256:abc AS web\nRUN npm ci\n' >"$REPO/Dockerfile"
  mkdir -p "$REPO/.github/workflows"
  write_workflow "node-version-file: .nvmrc"
}
write_workflow() { # <with-line for the setup-node step>
  cat >"$REPO/.github/workflows/x.yml" <<EOF
jobs:
  test:
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          $1
      - run: npm test
EOF
}

# Adds the Python side to make_repo's repo: .python-version, a python stage in the Dockerfile,
# a backend/pyproject.toml one level down, and a setup-python workflow.
make_py_repo() {
  make_repo
  printf '%s\n' "$PY_WANTED" >"$REPO/.python-version"
  printf 'FROM python:3.13-slim-bookworm@sha256:def AS api\n' >>"$REPO/Dockerfile"
  mkdir -p "$REPO/backend"
  write_pyproject '>=3.13'
  write_py_workflow "python-version-file: .python-version"
}
write_pyproject() { # <requires-python spec>
  printf '[project]\nname = "api"\nrequires-python = "%s"\n' "$1" >"$REPO/backend/pyproject.toml"
}
write_py_workflow() { # <with-line for the setup-python step>
  cat >"$REPO/.github/workflows/py.yml" <<EOF
jobs:
  test:
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          $1
      - run: pytest
EOF
}

run_toolchain() { run "$NODE_TOOLCHAIN" "$@"; }
run_check() { run "$TOOLCHAIN_CHECK" "$REPO"; }
last_line() { echo "${lines[${#lines[@]}-1]}"; }

# ---- node_toolchain.sh -----------------------------------------------------------------------

@test "node_toolchain: no args is usage, exit 2" {
  run_toolchain
  [ "$status" -eq 2 ]
  [[ "$output" == *"usage:"* ]]
}

@test "node_toolchain: no .nvmrc, exit 1" {
  run_toolchain "$REPO"
  [ "$status" -eq 1 ]
  [[ "$output" == *"no .nvmrc"* ]]
}

@test "node_toolchain: a major alone is rejected, exit 1" {
  echo 22 >"$REPO/.nvmrc"
  run_toolchain "$REPO"
  [ "$status" -eq 1 ]
  [[ "$output" == *"exact version"* ]]
}

@test "node_toolchain: PATH node already matches, exit 0 with no output" {
  echo "$WANTED" >"$REPO/.nvmrc"
  fake_path_node "$WANTED"
  run_toolchain "$REPO"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "node_toolchain: PATH node differs and the cache has it, prints the bin dir" {
  echo "$WANTED" >"$REPO/.nvmrc"
  cache_node "$WANTED"
  run_toolchain "$REPO"
  [ "$status" -eq 0 ]
  [ "$output" = "$STORE/v$WANTED/bin" ]
}

@test "node_toolchain: cold cache while offline fails loudly, exit 1" {
  echo "$WANTED" >"$REPO/.nvmrc"
  run_toolchain "$REPO"
  [ "$status" -eq 1 ]
  [[ "$output" == *"not cached"* ]]
  [[ "$output" == *"DEVKIT_OFFLINE"* ]]
  [ ! -e "$STORE" ]
}

@test "node_toolchain: v-prefix and trailing newline in .nvmrc are accepted" {
  printf 'v%s\n' "$WANTED" >"$REPO/.nvmrc"
  cache_node "$WANTED"
  run_toolchain "$REPO"
  [ "$status" -eq 0 ]
  [ "$output" = "$STORE/v$WANTED/bin" ]
}

# ---- toolchain_check.sh ----------------------------------------------------------------------

@test "toolchain_check: no .nvmrc or .python-version means nothing to check, exit 0" {
  make_repo
  rm "$REPO/.nvmrc"
  run_check
  [ "$status" -eq 0 ]
  [ "$output" = "toolchain-check: no .nvmrc or .python-version; nothing to check" ]
}

@test "toolchain_check: consistent Node-only repo passes and skips python" {
  make_repo
  run_check
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "toolchain-check: no .python-version; python not checked" ]
  [ "$(last_line)" = "toolchain-check: ok (node $WANTED)" ]
}

@test "toolchain_check: Dockerfile on another major fails and names the tag" {
  make_repo
  printf 'FROM node:26-alpine\n' >"$REPO/Dockerfile"
  run_check
  [ "$status" -eq 1 ]
  [[ "$output" == *"Dockerfile uses node:26-alpine"* ]]
  [[ "$output" == *"(major 22)"* ]]
  [[ "$output" == *"toolchain-check: FAIL"* ]]
}

@test "toolchain_check: setup-node with inline node-version fails with file:line" {
  make_repo
  write_workflow "node-version: 22"
  run_check
  [ "$status" -eq 1 ]
  [[ "$output" == *".github/workflows/x.yml:7: setup-node pins node-version inline"* ]]
  [[ "$output" == *"node-version-file"* ]]
}

@test "toolchain_check: node-version in a non-setup-node step is not flagged" {
  make_repo
  cat >>"$REPO/.github/workflows/x.yml" <<'EOF'
      - run: echo "node-version: 26 is what the image used to say"
EOF
  run_check
  [ "$status" -eq 0 ]
  [ "$(last_line)" = "toolchain-check: ok (node $WANTED)" ]
}

@test "toolchain_check: .nvmrc holding only a major fails" {
  make_repo
  echo 22 >"$REPO/.nvmrc"
  run_check
  [ "$status" -eq 1 ]
  [[ "$output" == *"exact version"* ]]
}

@test "toolchain_check: FROM --platform=... node:22-slim matches major 22" {
  make_repo
  printf 'FROM --platform=linux/amd64 node:22-slim\n' >"$REPO/Dockerfile"
  run_check
  [ "$status" -eq 0 ]
  [ "$(last_line)" = "toolchain-check: ok (node $WANTED)" ]
}

# ---- toolchain_check.sh: python --------------------------------------------------------------

@test "toolchain_check: consistent node+python repo passes and names both" {
  make_py_repo
  run_check
  [ "$status" -eq 0 ]
  [ "$output" = "toolchain-check: ok (node $WANTED, python $PY_WANTED)" ]
}

@test "toolchain_check: MAJOR.MINOR.PATCH in .python-version is accepted" {
  make_py_repo
  echo 3.13.7 >"$REPO/.python-version"
  run_check
  [ "$status" -eq 0 ]
  [ "$output" = "toolchain-check: ok (node $WANTED, python 3.13.7)" ]
}

@test "toolchain_check: .python-version holding only a major fails" {
  make_py_repo
  echo 3 >"$REPO/.python-version"
  run_check
  [ "$status" -eq 1 ]
  [[ "$output" == *".python-version must hold MAJOR.MINOR"* ]]
}

@test "toolchain_check: FROM python:3.14-slim against 3.13 fails and names the tag" {
  make_py_repo
  printf 'FROM --platform=linux/amd64 python:3.14-slim AS api\n' >>"$REPO/Dockerfile"
  run_check
  [ "$status" -eq 1 ]
  [[ "$output" == *"Dockerfile uses python:3.14-slim"* ]]
  [[ "$output" == *"(python 3.13)"* ]]
  [[ "$output" == *"toolchain-check: FAIL"* ]]
}

@test "toolchain_check: uv image on python3.14 fails" {
  make_py_repo
  printf 'FROM ghcr.io/astral-sh/uv:python3.14-bookworm AS build\n' >"$REPO/backend/Dockerfile"
  run_check
  [ "$status" -eq 1 ]
  [[ "$output" == *"backend/Dockerfile uses ghcr.io/astral-sh/uv:python3.14-bookworm"* ]]
}

@test "toolchain_check: uv image on python3.13 passes" {
  make_py_repo
  printf 'FROM ghcr.io/astral-sh/uv:python3.13-bookworm AS build\n' >"$REPO/backend/Dockerfile"
  run_check
  [ "$status" -eq 0 ]
  [ "$(last_line)" = "toolchain-check: ok (node $WANTED, python $PY_WANTED)" ]
}

@test "toolchain_check: requires-python lower bound on another minor fails" {
  make_py_repo
  write_pyproject '>=3.12'
  run_check
  [ "$status" -eq 1 ]
  [[ "$output" == *"backend/pyproject.toml requires-python '>=3.12' has lower bound 3.12"* ]]
}

@test "toolchain_check: requires-python >=3.13,<3.14 passes" {
  make_py_repo
  write_pyproject '>=3.13, <3.14'
  run_check
  [ "$status" -eq 0 ]
  [ "$output" = "toolchain-check: ok (node $WANTED, python $PY_WANTED)" ]
}

@test "toolchain_check: requires-python ==3.13.* and ~=3.13 pass" {
  make_py_repo
  write_pyproject '==3.13.*'
  printf '[project]\nrequires-python = "~=3.13"\n' >"$REPO/pyproject.toml"
  run_check
  [ "$status" -eq 0 ]
  [ "$output" = "toolchain-check: ok (node $WANTED, python $PY_WANTED)" ]
}

@test "toolchain_check: requires-python form the parser does not understand warns and passes" {
  make_py_repo
  write_pyproject '>=3.13,!=3.13.1'
  run_check
  [ "$status" -eq 0 ]
  [[ "$output" == *"warning: backend/pyproject.toml requires-python '>=3.13,!=3.13.1' is not a form"* ]]
  [ "$(last_line)" = "toolchain-check: ok (node $WANTED, python $PY_WANTED)" ]
}

@test "toolchain_check: setup-python with inline python-version fails with file:line" {
  make_py_repo
  write_py_workflow "python-version: '3.13'"
  run_check
  [ "$status" -eq 1 ]
  [[ "$output" == *".github/workflows/py.yml:7: setup-python pins python-version inline"* ]]
  [[ "$output" == *"python-version-file: .python-version"* ]]
}

@test "toolchain_check: python-only repo checks python without .nvmrc" {
  make_py_repo
  rm "$REPO/.nvmrc"
  run_check
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "toolchain-check: no .nvmrc; node not checked" ]
  [ "$(last_line)" = "toolchain-check: ok (python $PY_WANTED)" ]
}
