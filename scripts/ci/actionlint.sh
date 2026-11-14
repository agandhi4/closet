#!/usr/bin/env bash
# `make actionlint-check` (part of ci-quick): actionlint over .github/workflows.
# It exists because a step's `with:` once landed under a `run:` step in nightly.yml (#635):
# GitHub refused the file, so the nightly never started and nothing said so. devkit's
# workflows_check.sh judges the Actions rules, not whether a file is valid.
#
# The binary is the upstream release, pinned by version and sha256 below, downloaded once
# into a per-user cache (never the repo) and verified at download. The npm wrapper
# `actionlint` was rejected: it is a wasm build of 1.6.x that does not know ubuntu-24.04 and
# crashes on a second file. Needs curl and network on the first run per machine (CI runners
# and the publisher host have both); a machine without either sets ACTIONLINT_BIN to a binary.
# Bumping: the new version and its four checksums from the release's checksums.txt.
set -euo pipefail

VERSION=1.7.12

sha256_of() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

fetch() {
  local platform archive_sha dir archive
  case "$(uname -s)" in Darwin) platform=darwin ;; Linux) platform=linux ;; *) echo "actionlint: unsupported OS $(uname -s)" >&2; exit 1 ;; esac
  case "$(uname -m)" in x86_64 | amd64) platform+=_amd64 ;; arm64 | aarch64) platform+=_arm64 ;; *) echo "actionlint: unsupported CPU $(uname -m)" >&2; exit 1 ;; esac
  case $platform in
    darwin_amd64) archive_sha=5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644 ;;
    darwin_arm64) archive_sha=aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f ;;
    linux_amd64) archive_sha=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8 ;;
    linux_arm64) archive_sha=325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6 ;;
  esac
  dir=${XDG_CACHE_HOME:-$HOME/.cache}/closet/actionlint-$VERSION-$platform
  if [[ ! -x $dir/actionlint ]]; then
    mkdir -p "$dir"
    archive=$dir/archive.tar.gz
    if ! curl -fsSL --retry 2 -o "$archive" \
      "https://github.com/rhysd/actionlint/releases/download/v$VERSION/actionlint_${VERSION}_$platform.tar.gz"; then
      rm -rf "$dir"
      echo "actionlint: could not download v$VERSION; connect, or set ACTIONLINT_BIN to a binary" >&2
      exit 1
    fi
    if [[ $(sha256_of "$archive") != "$archive_sha" ]]; then
      rm -rf "$dir"
      echo "actionlint: v$VERSION archive does not match its pinned sha256" >&2
      exit 1
    fi
    tar -xzf "$archive" -C "$dir" actionlint
    rm "$archive"
  fi
  echo "$dir/actionlint"
}

bin=${ACTIONLINT_BIN:-$(fetch)}
cd "$(dirname "$0")/../.."
shopt -s nullglob
files=(.github/workflows/*.yml .github/workflows/*.yaml)
"$bin" "${files[@]}"
echo "actionlint: ${#files[@]} workflow files clean"
