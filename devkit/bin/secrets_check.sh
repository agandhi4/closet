#!/usr/bin/env bash
# Guard for ci-quick: no credential is committed. Scans the TRACKED files (git ls-files, so a
# .env the ignore file keeps out never counts and Actions sees what a laptop sees) for
# high-confidence secret shapes, the way gitleaks' default rules do, without the binary:
#   - private key blocks            -----BEGIN (RSA|EC|DSA|OPENSSH|PGP|) PRIVATE KEY-----
#   - AWS access key ids            AKIA[0-9A-Z]{16}
#   - GitHub tokens                 ghp_|gho_|ghu_|ghs_|ghr_ + 36 chars, github_pat_ + 22_59 chars
#   - Slack tokens                  xox[abprs]-...
#   - Google API keys               AIza[0-9A-Za-z_-]{35}
#   - Stripe live keys              sk_live_[0-9a-zA-Z]{24,}
#   - Anthropic / OpenAI keys       sk-ant-..., sk-proj-... (40+ chars)
#   - age secret keys               AGE-SECRET-KEY-1[0-9A-Z]{58}
#   - assignments of a long literal to a secret-named variable:
#     (api[_-]?key|secret|token|password|passwd)\s*[:=]\s*['"][A-Za-z0-9+/_=.-]{20,}['"]
#     unless the literal is a placeholder (contains example|placeholder|changeme|dummy|test|
#     xxx|<|>|\$\{), or the file is a test or fixture (tests/, test/, e2e/, *.test.*, *.spec.*,
#     test_*): a 20-character literal handed to `password` in a test is a fixture. The
#     key-shaped rules above still apply to tests: a real AWS key in a fixture is still a leak.
# Skipped: binary files, lock files, minified bundles (*.min.*), and the paths in
# scripts/ci/secrets_allow.txt (`<path-glob> <reason>` per line; a fixture with a deliberately
# fake key names itself there, and the reason is reviewed). The allow file is for fixtures,
# never for a real credential: rotate that and remove it from history.
# Output: `secrets-check: <file>:<line>: <rule>` per hit on stderr (the matched text is NEVER
# printed: the log must not become the leak), then `secrets-check: ok (<n> files)` on stdout or
# `secrets-check: FAIL` on stderr. Exit 0 ok, 1 hits, 2 usage.
# Usage: devkit/bin/secrets_check.sh [repo-root]      (part of ci-quick; scorecard T11 sec.secrets)
set -uo pipefail
ROOT=${1:-$(git rev-parse --show-toplevel 2>/dev/null)} || { echo "usage: secrets_check.sh [repo-root]" >&2; exit 2; }
cd "$ROOT" || exit 2
ALLOW=scripts/ci/secrets_allow.txt

rc=0 nfiles=0
fail() { rc=1; echo "secrets-check: $*" >&2; }

allowed() { # <path> -> 0 when an allow line's glob matches
  local glob _reason
  [ -f "$ALLOW" ] || return 1
  while read -r glob _reason; do
    case "$glob" in ''|'#'*) continue ;; esac
    # shellcheck disable=SC2254  # the glob is the point
    case "$1" in $glob) return 0 ;; esac
  done <"$ALLOW"
  return 1
}

# One extended regex per rule, applied with grep -nE; the rule name is what gets printed.
RULES='private-key|-----BEGIN [A-Z ]*PRIVATE KEY-----
aws-access-key|\bAKIA[0-9A-Z]{16}\b
github-token|\bgh[pousr]_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b
slack-token|\bxox[abprs]-[A-Za-z0-9-]{10,}\b
google-api-key|\bAIza[0-9A-Za-z_-]{35}\b
stripe-live-key|\bsk_live_[0-9a-zA-Z]{24,}\b
llm-api-key|\bsk-(ant|proj)-[A-Za-z0-9_-]{40,}\b
age-secret-key|\bAGE-SECRET-KEY-1[0-9A-Z]{58}\b
secret-assignment|(api[_-]?key|secret|token|password|passwd)[A-Za-z0-9_]*[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9+/_=.-]{20,}["'"'"']'
PLACEHOLDER='example|placeholder|changeme|change-me|dummy|test|fake|xxx|<|>|\$\{|your[_-]'

while IFS= read -r f; do
  [ -f "$f" ] || continue
  case "$f" in
    *.min.js|*.min.css|*.map|*.lock|package-lock.json|pnpm-lock.yaml|*.png|*.jpg|*.jpeg|*.gif|*.webp|*.ico|*.pdf|*.woff|*.woff2|*.ttf|*.zip|*.gz|*.sqlite|*.db) continue ;;
  esac
  if allowed "$f"; then continue; fi
  # Binary: a NUL in the first 8 KB (LC_ALL=C: bytes, not characters, whatever the locale).
  if LC_ALL=C head -c 8192 "$f" | LC_ALL=C tr -d '\000' | cmp -s - <(head -c 8192 "$f"); then :; else continue; fi
  case "$f" in
    tests/*|*/tests/*|test/*|*/test/*|e2e/*|*/e2e/*|*.test.*|*.spec.*|test_*|*/test_*) is_test=1 ;;
    *) is_test=0 ;;
  esac
  nfiles=$((nfiles + 1))
  while IFS='|' read -r rule re; do
    [ -n "$rule" ] || continue
    # Variable names come in any case (DB_PASSWORD); key shapes are case-exact (AKIA, ghp_).
    ci=""; [ "$rule" = secret-assignment ] && ci=i
    while IFS=: read -r line _; do
      [ -n "$line" ] || continue
      if [ "$rule" = secret-assignment ]; then
        [ "$is_test" = 1 ] && continue
        sed -n "${line}p" "$f" | LC_ALL=C grep -qiE "$PLACEHOLDER" && continue
      fi
      fail "$f:$line: $rule"
    done < <(LC_ALL=C grep -n"$ci"E -e "$re" "$f" 2>/dev/null | cut -d: -f1 | sed 's/$/:/')
  done <<<"$RULES"
done < <(git ls-files)

if [ $rc = 0 ]; then
  echo "secrets-check: ok ($nfiles files)"
else
  echo "secrets-check: FAIL (a committed credential is rotated, then removed from history; a fixture's fake key is named in $ALLOW with its reason)" >&2
fi
exit $rc
