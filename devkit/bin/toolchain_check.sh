#!/usr/bin/env bash
# Guard: one version string per toolchain per repo. Each toolchain has a single declaration file;
# everything that builds or tests with it must agree, or a dependency bot bumps one copy and the
# image runs an interpreter the tests never saw (finplat's Dockerfile sat on Node 26 while CI
# tested 22, and on python:3.14 while requires-python said 3.13).
# Node (.nvmrc, exact version):
#   - every `FROM node:<tag>` in Dockerfile* has the same major
#   - every setup-node step in .github/workflows uses `node-version-file: .nvmrc`, not `node-version:`
# Python (.python-version, MAJOR.MINOR or MAJOR.MINOR.PATCH; compared on MAJOR.MINOR):
#   - every `FROM python:<tag>` and uv-style `FROM …:python3.13-…` in Dockerfile* has the same MAJOR.MINOR
#   - every `requires-python` in pyproject.toml (root and one level down) has that MAJOR.MINOR as its
#     lower bound; specs outside the simple forms (>=X.Y[,<…], ==X.Y.*, ~=X.Y) warn, not fail
#   - every setup-python step uses `python-version-file: .python-version`, not `python-version:`
# A missing declaration file skips that toolchain (Node-only repos have no .python-version).
# Dockerfiles are scanned at the root and one level down (orbit/frontend/Dockerfile).
# Usage: devkit/bin/toolchain_check.sh [repo-root]      (part of ci-quick)
set -uo pipefail
ROOT=${1:-$(git rev-parse --show-toplevel)}
cd "$ROOT" || exit 2
rc=0
checked=()
fail() { echo "toolchain-check: $*" >&2; rc=1; }
warn() { echo "toolchain-check: warning: $*" >&2; }

if [ ! -f .nvmrc ] && [ ! -f .python-version ]; then
  echo "toolchain-check: no .nvmrc or .python-version; nothing to check"; exit 0
fi

dockerfiles() { for f in Dockerfile Dockerfile.* */Dockerfile */Dockerfile.*; do [ -f "$f" ] && echo "$f"; done; }
workflows() { for f in .github/workflows/*.yml .github/workflows/*.yaml; do [ -f "$f" ] && echo "$f"; done; }

# A setup-<lang> step that pins `<key>:` inline inside its `with:` block is a second copy of the
# version; the `<key>-file:` form reads the one declaration. Prints offending line numbers.
inline_pins() { # <workflow> <action> <key>
  awk -v action="actions/$2" -v key="$3:" '
    index($0, "uses:") && index($0, action) { in_step=1; next }
    in_step && /^[[:space:]]*-[[:space:]]/ { in_step=0 }
    in_step && index($0, key) { print NR }
  ' "$1"
}

FROM_RE='^FROM[[:space:]]+(--platform=[^[:space:]]+[[:space:]]+)?'

check_node() {
  if [ ! -f .nvmrc ]; then echo "toolchain-check: no .nvmrc; node not checked"; return; fi
  local version major df line tag wf lineno
  version=$(tr -d '[:space:]' < .nvmrc); version=${version#v}
  case "$version" in
    [0-9]*.[0-9]*.[0-9]*) major=${version%%.*} ;;
    *) fail ".nvmrc must hold an exact version like 22.23.3 (got '$version')"; return ;;
  esac
  while IFS= read -r df; do
    while IFS= read -r line; do
      tag=$(sed -E "s/${FROM_RE}node:([^[:space:]@]+).*/\\2/" <<< "$line")
      [ "${tag%%[.-]*}" = "$major" ] || fail "$df uses node:$tag; .nvmrc says $version (major $major)"
    done < <(grep -E "${FROM_RE}node:" "$df" || true)
  done < <(dockerfiles)
  while IFS= read -r wf; do
    for lineno in $(inline_pins "$wf" setup-node node-version); do
      fail "$wf:$lineno: setup-node pins node-version inline; use node-version-file: .nvmrc"
    done
  done < <(workflows)
  checked+=("node $version")
}

check_python() {
  if [ ! -f .python-version ]; then echo "toolchain-check: no .python-version; python not checked"; return; fi
  local version mm df line image tag found pp spec raw lower wf lineno
  version=$(tr -d '[:space:]' < .python-version)
  if [[ "$version" =~ ^([0-9]+\.[0-9]+)(\.[0-9]+)?$ ]]; then
    mm=${BASH_REMATCH[1]}
  else
    fail ".python-version must hold MAJOR.MINOR or MAJOR.MINOR.PATCH like 3.13 or 3.13.7 (got '$version')"; return
  fi

  # Official images carry the version as the tag (python:3.13-slim); uv images embed it in the
  # tag of another image (ghcr.io/astral-sh/uv:python3.13-bookworm). Other FROM lines are ignored.
  while IFS= read -r df; do
    while IFS= read -r line; do
      image=$(sed -E "s/${FROM_RE}([^[:space:]]+).*/\\2/" <<< "$line"); image=${image%%@*}
      [[ "$image" == *:* ]] || continue
      tag=${image##*:}; image=${image%:*}
      if [ "${image##*/}" = python ]; then
        [[ "$tag" =~ ^([0-9]+\.[0-9]+) ]] && found=${BASH_REMATCH[1]} || found=
      elif [[ "$tag" =~ (^|[^[:alnum:]])python([0-9]+\.[0-9]+) ]]; then
        found=${BASH_REMATCH[2]}
      else
        continue
      fi
      [ "$found" = "$mm" ] || fail "$df uses $image:$tag; .python-version says $version (python $mm)"
    done < <(grep -E "$FROM_RE" "$df" || true)
  done < <(dockerfiles)

  for pp in pyproject.toml */pyproject.toml; do
    [ -f "$pp" ] || continue
    while IFS= read -r raw; do
      spec=$(sed -E "s/^[[:space:]]*requires-python[[:space:]]*=[[:space:]]*[\"']([^\"']*)[\"'].*/\\1/" <<< "$raw" | tr -d '[:space:]')
      if [[ "$spec" =~ ^(\>=|==|~=)([0-9]+\.[0-9]+)(\.[0-9]+|\.\*)?(,\<[0-9]+(\.[0-9]+)*)?$ ]]; then
        lower=${BASH_REMATCH[2]}
        [ "$lower" = "$mm" ] || fail "$pp requires-python '$spec' has lower bound $lower; .python-version says $version (python $mm)"
      else
        warn "$pp requires-python '$spec' is not a form this check parses; verify it admits python $mm by hand"
      fi
    done < <(grep -E '^[[:space:]]*requires-python[[:space:]]*=' "$pp" || true)
  done

  while IFS= read -r wf; do
    for lineno in $(inline_pins "$wf" setup-python python-version); do
      fail "$wf:$lineno: setup-python pins python-version inline; use python-version-file: .python-version"
    done
  done < <(workflows)
  checked+=("python $version")
}

check_node
check_python

if [ $rc = 0 ]; then
  summary=$(IFS=,; echo "${checked[*]}"); echo "toolchain-check: ok (${summary//,/, })"
else
  echo "toolchain-check: FAIL" >&2
fi
exit $rc
