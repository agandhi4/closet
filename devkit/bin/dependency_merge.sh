#!/usr/bin/env bash
# Nightly gated merge of minor and patch dependency PRs. Owner decision 2026-10-21: keep
# automatic minor/patch updates, but route every one through the repo's own gate; Renovate never
# merges by itself and no paid GitHub feature is involved. Scheduled by
# bin/install_dependency_merge.sh (templates/launchd/com.agandhi4.devkit.dependency-merge.plist).
#
# Usage: bin/dependency_merge.sh [--max <n>] [--dry-run] <repo-root>...
#   <repo-root>  a checkout whose scripts/ci/gate_plan.sh has literal GATE_SLUG and
#                GATE_STATE_NAME lines and whose Makefile has `gate` and `merge`
#   --max <n>    PRs gated per repo per run (default 3); the rest wait for the next run
#   --dry-run    print what each PR would get; no gate, merge, comment or log line
#
# Per repo: fetch origin main and add a detached worktree of it, so the plan (GATE_SLUG,
# GATE_STATE_NAME) and the vendored devkit are main's, never a developer's branch.
# _dependency_pr.py classifies the open Renovate and Dependabot PRs against main, oldest first;
# majors and unreadable update types are skipped and listed. Then, per minor/patch PR:
#   - behind main: gated like any PR. The gate tests the merge into the current main and
#     pr_merge.sh merges only onto the main it gated, so a branch that is not rebased is no risk;
#     waiting for a rebase was (homelab #128, 2026-10-22): with Renovate's rebaseWhen
#     behind-base-branch, each merge this run made had Renovate force-push every other open
#     branch, racing the next merge. renovate/default.json keeps rebaseWhen auto (conflicts only,
#     no automerge and no up-to-date protection in this fleet), and Dependabot rebases only on a
#     conflict too.
#   - conflicting: `git merge-tree` of the head into the current origin/main fails. Skipped.
#   - this head already failed a gate here (the marker comment below): skipped until it moves.
#   - else `make gate PR=<n> GATE_ARGS="--expect-head <head>"`, which takes a machine gate slot
#     like any gate. PASS: `make merge PR=<n>`; a refusal to re-gate (main or the head moved
#     after the gate, or GitHub refused the merge for it: pr_merge.sh's `re-gate:` lines) is
#     "skipped behind", and the next run gates the new tree. Otherwise the verdict is the gate
#     record's (gate_record.py verdict-of), never make's exit code: make exits 2 for any failed recipe.
#     fail with a job failing on the PR's code: one PR comment per head naming the failing jobs
#     and rules (gate_record.py failures). error, no record of the head, or only machine
#     failures (a gate step such as worktree, toolchain or a conflict; the silence watchdog; a
#     budget overrun under load: `failures --code-only` is empty): logged with no comment and
#     no marker, so the next run retries the head. A Dependabot head is never parked on the box.
# Output: one `dependency-merge: <slug>#<n> <outcome> <detail>` line per PR, outcome one of
#   merged failed error refused skipped would-gate, appended with a UTC stamp to
#   $XDG_STATE_HOME/devkit/dependency-merge.log; the gate and merge output of a PR go to
#   $XDG_STATE_HOME/devkit/dependency-merge/<repo>-<n>.log. Then one summary line per repo.
# Kill switch: ${XDG_CONFIG_HOME:-~/.config}/devkit/dependency-merge.off, read before every PR.
# One run at a time (flock); a second run exits 0 with one line.
# Exit 0 when it ran, whatever each PR's outcome; 1 when no repo could be read; 2 usage, a
# missing tool (bin/_toolchain_lib.sh's devkit_preflight: one line naming each), checked before any repo.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2
# shellcheck source=bin/_gate_env.sh
. "$HERE/_gate_env.sh"
# shellcheck source=bin/_toolchain_lib.sh
. "$HERE/_toolchain_lib.sh"

readonly MARKER=devkit-dependency-merge
STATE=${XDG_STATE_HOME:-$HOME/.local/state}/devkit
OFF=${XDG_CONFIG_HOME:-$HOME/.config}/devkit/dependency-merge.off
LOG=$STATE/dependency-merge.log

usage() { echo "usage: dependency_merge.sh [--max <n>] [--dry-run] <repo-root>..."; }
MAX=3
DRY_RUN=0
REPOS=()
parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --max)
        [ $# -ge 2 ] && [[ "$2" =~ ^[1-9][0-9]*$ ]] || { usage >&2; exit 2; }
        MAX=$2; shift ;;
      --dry-run) DRY_RUN=1 ;;
      -h|--help) usage; exit 0 ;;
      -*) usage >&2; exit 2 ;;
      *) REPOS+=("$1") ;;
    esac
    shift
  done
  [ "${#REPOS[@]}" -gt 0 ] || { usage >&2; exit 2; }
}

require_tools() {
  # Before any repo: without one every gate fails the same way, logged as N per-PR box errors
  # (2026-10-22: launchd's PATH had only Xcode's 3.9, then no uv). The toolchain directory goes
  # first on PATH, too, so a repo whose vendored devkit predates _toolchain_lib.sh still runs its
  # bare python3 and uv calls on it.
  devkit_preflight gh git make flock -- "${REPOS[@]}" \
    || { echo "dependency-merge: $DEVKIT_PREFLIGHT_ERROR; no repo gated" >&2; exit 2; }
  devkit_toolchain_bin || { echo "dependency-merge: $DEVKIT_PYTHON_ERROR; no repo gated" >&2; exit 2; }
  export PATH="$DEVKIT_TOOLCHAIN_BIN:$PATH"
}

parse_args "$@"
require_tools

OFF_SAID=0
switched_off() {
  [ -e "$OFF" ] || return 1
  [ "$OFF_SAID" = 1 ] || echo "dependency-merge: $OFF exists; not running"
  OFF_SAID=1
}
switched_off && exit 0

mkdir -p "$STATE/dependency-merge" || exit 2
# fd 8 is the run lock; every make below closes it (8>&-), so a process a gate leaves behind
# cannot hold it into the next night.
exec 8>>"$STATE/dependency-merge.lock"
flock -n 8 || { echo "dependency-merge: another run holds $STATE/dependency-merge.lock; not running"; exit 0; }

WT=""
OUTCOMES=""
cleanup_worktree() {
  [ -n "$WT" ] || return 0
  git -C "$WT" worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf "$WT"
  WT=""
}
trap cleanup_worktree EXIT

# record <slug>#<n> <outcome> <detail>
record() {
  local line="dependency-merge: $1 $2 $3"
  echo "$line"
  OUTCOMES="$OUTCOMES $2"
  [ "$DRY_RUN" = 1 ] || printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$line" >>"$LOG"
}

# summary <label>: the counts of the outcomes recorded since the last summary, in a fixed order.
summary() {
  local outcome n counts=""
  for outcome in merged failed error refused skipped would-gate; do
    n=$(tr ' ' '\n' <<<"$OUTCOMES" | grep -cx -- "$outcome")
    [ "$n" = 0 ] || counts="${counts:+$counts, }$outcome $n"
  done
  echo "dependency-merge: $1: ${counts:-no dependency PRs}"
  OUTCOMES=""
}

# failure_comment <n> <head> <failures>: the PR comment for a failed gate, marked with its head.
# shellcheck disable=SC2016  # the backticks are markdown code spans, not command substitution
failure_comment() {
  printf '<!-- %s head=%s -->\n' "$MARKER" "$2"
  printf '`make gate PR=%s` failed on head %s (bin/dependency_merge.sh, the nightly dependency merge). ' "$1" "${2:0:12}"
  printf 'This PR stays open; the nightly run gates it again once its head changes.\n\n'
  printf '%s\n' "${3:-no gate record of this head; see the log below}" | sed 's/^/- /'
  printf '\nLog on %s: `%s`\n' "$(hostname -s)" "$PR_LOG"
}

# gate_pr <slug> <state name> <n> <head>: gate, then merge or comment, and record the outcome.
gate_pr() {
  local slug=$1 n=$3 head=$4 rc gate_json verdict failures refusal
  gate_json=${XDG_STATE_HOME:-$HOME/.local/state}/$2/logs/$n/gate.json
  PR_LOG=$STATE/dependency-merge/${slug#*/}-$n.log
  make -C "$WT" gate PR="$n" GATE_ARGS="--expect-head $head" >"$PR_LOG" 2>&1 8>&-
  rc=$?
  if [ "$rc" = 0 ]; then
    if make -C "$WT" merge PR="$n" >>"$PR_LOG" 2>&1 8>&-; then
      record "$slug#$n" merged "head ${head:0:12}"
    else
      refusal=$(grep -E '^merge: refused: ' "$PR_LOG" | tail -n 1)
      case "$refusal" in
        "merge: refused: re-gate: "*) record "$slug#$n" skipped "behind (${refusal#merge: refused: re-gate: }); the next run re-gates" ;;
        *) record "$slug#$n" refused "${refusal:-make merge failed; see $PR_LOG}" ;;
      esac
    fi
    return 0
  fi
  verdict=$("$DEVKIT_PYTHON" -I "$HERE/gate_record.py" verdict-of "$gate_json" "$head")
  if [ "$verdict" != fail ]; then
    record "$slug#$n" error "make gate exit $rc, gate verdict ${verdict:-unrecorded} (the box, not the PR); see $PR_LOG"
    return 0
  fi
  failures=$("$DEVKIT_PYTHON" -I "$HERE/gate_record.py" failures "$gate_json" "$head")
  if [ -z "$("$DEVKIT_PYTHON" -I "$HERE/gate_record.py" failures --code-only "$gate_json" "$head")" ]; then
    record "$slug#$n" error "only the machine failed (gate step, silence or budget; not the PR): $(paste -sd ';' - <<<"${failures:-whole-gate budget}"); see $PR_LOG"
    return 0
  fi
  if gh pr comment "$n" --repo "$slug" --body "$(failure_comment "$n" "$head" "$failures")" >/dev/null; then
    record "$slug#$n" failed "$(paste -sd ';' - <<<"${failures:-no gate record}"); commented"
  else
    record "$slug#$n" failed "$(paste -sd ';' - <<<"${failures:-no gate record}"); comment not posted (gh above)"
  fi
}

# check_pr <slug> <n> <head>: print why PR <n> is not gated now, or nothing.
check_pr() {
  local slug=$1 n=$2 head=$3 bodies
  # refs/worktree/ is private to this worktree and goes with it: the checkout's refs stay as they were.
  fetch_main "$WT" "+pull/$n/head:refs/worktree/dependency-pr" \
    || { echo "error cannot fetch main and PR #$n (git above)"; return; }
  [ "$(git -C "$WT" rev-parse refs/worktree/dependency-pr)" = "$head" ] \
    || { echo "skipped head moved since the PR list; next run"; return; }
  git -C "$WT" merge-tree --write-tree origin/main "$head" >/dev/null 2>&1 \
    || { echo "skipped conflicts with main, Renovate will rebase"; return; }
  bodies=$(gh api "repos/$slug/issues/$n/comments" --paginate --jq '.[].body') \
    || { echo "error cannot read PR #$n's comments (gh above)"; return; }
  if grep -qF "<!-- $MARKER head=$head -->" <<<"$bodies"; then
    echo "skipped its gate already failed on head ${head:0:12} (see its comment); a new head retries"
  fi
}

# list_prs <slug>: _dependency_pr.py's lines for the open PRs against main. The list never asks
# for `commits` (GitHub refuses that query for 100 PRs: _dependency_pr.py's docstring); the PRs
# whose verdict reads commits get one `gh pr view` each. gh pages the list 100 at a time up to
# --limit, so a repo with more than 100 open PRs is listed whole.
list_prs() {
  local list numbers n
  list=$(gh pr list --repo "$1" --base main --state open --limit 1000 \
    --json number,author,title,labels,headRefOid,createdAt,body) || return
  numbers=$("$DEVKIT_PYTHON" -I "$HERE/_dependency_pr.py" needs-commits <<<"$list") || return
  {
    printf '%s\n' "$list"
    for n in $numbers; do
      gh pr view "$n" --repo "$1" --json number,headRefOid,commits || exit
    done
  } | "$DEVKIT_PYTHON" -I "$HERE/_dependency_pr.py"
}

# repo_error <label> <why>: one line, and the repo counts as not read.
repo_error() { echo "dependency-merge: $1: cannot run: $2" >&2; return 1; }

# open_repo <dir>: set SLUG, STATE_NAME, PRS (_dependency_pr.py lines) and WT (a detached
# worktree of origin/main now, whose plan and vendored devkit run every gate and merge).
open_repo() {
  local root
  root=$(cd "$1" 2>/dev/null && pwd -P) || { repo_error "$1" "not a directory"; return; }
  gate_plan_main "$root" || { repo_error "$root" "$PLAN_ERROR"; return; }
  SLUG=$PLAN_SLUG STATE_NAME=$PLAN_STATE_NAME
  PRS=$(list_prs "$SLUG") || { repo_error "$SLUG" "cannot list its open PRs (gh or _dependency_pr.py above)"; return; }
  WT=$STATE/dependency-merge/wt-${SLUG#*/}
  git -C "$root" worktree remove --force "$WT" >/dev/null 2>&1
  rm -rf "$WT"
  git -C "$root" worktree add -q --detach "$WT" "$PLAN_MAIN" || { WT=""; repo_error "$SLUG" "cannot add a worktree of main (git above)"; return; }
}

# handle_pr <n> <head> <decision> <detail>: record a skip, or gate (GATED counts toward --max).
handle_pr() {
  local n=$1 head=$2 why
  [ "$3" = gate ] || { record "$SLUG#$n" skipped "$4"; return; }
  [ "$GATED" -lt "$MAX" ] || { record "$SLUG#$n" skipped "limit of $MAX gated per run reached; next run"; return; }
  why=$(check_pr "$SLUG" "$n" "$head")
  [ -z "$why" ] || { record "$SLUG#$n" "${why%% *}" "${why#* }"; return; }
  GATED=$((GATED + 1))
  if [ "$DRY_RUN" = 1 ]; then
    record "$SLUG#$n" would-gate "$4: make gate PR=$n, then make merge PR=$n on PASS"
  else
    gate_pr "$SLUG" "$STATE_NAME" "$n" "$head"
  fi
}

run_repo() {
  local n head decision detail
  open_repo "$1" || return
  GATED=0
  while IFS=$'\t' read -r n head _ decision detail <&3; do
    [ -n "$n" ] || continue  # the here-string of an empty list is one empty line
    if switched_off; then break; fi
    handle_pr "$n" "$head" "$decision" "$detail"
  done 3<<<"$PRS"
  cleanup_worktree
  summary "$SLUG"
}

read_any=0
for repo in "${REPOS[@]}"; do
  if switched_off; then break; fi
  run_repo "$repo" && read_any=1
done
[ "$read_any" = 1 ] || exit 1
exit 0
