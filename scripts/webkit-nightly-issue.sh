#!/usr/bin/env bash
# Keeps ONE tracking issue in step with the nightly WebKit run (nightly.yml, job `webkit`, #179):
# a red run opens it, or updates its list of failing specs (with a comment when the list changes),
# and a green run closes it. The run never blocks anything; this issue is how a failure is seen.
#
# Usage: scripts/webkit-nightly-issue.sh <results-dir>
#   <results-dir>  one subdirectory per project, each with Playwright's JSON report (results.json).
#                  A project without one failed before its suite finished (install, build, timeout).
# Environment:
#   OUTCOME   the webkit job's result: success, failure or cancelled (needs.webkit.result)
#   RUN_URL   the workflow run, linked from the issue
#   GH_TOKEN, GH_REPO   for gh: the workflow's GITHUB_TOKEN with issues: write, owner/repo

# The issue's backticks are Markdown, not command substitutions.
# shellcheck disable=SC2016
set -euo pipefail

RESULTS_DIR=${1:?usage: webkit-nightly-issue.sh <results-dir>}
: "${OUTCOME:?}" "${RUN_URL:?}" "${GH_REPO:?}"
TITLE='Nightly WebKit / Mobile Safari run is failing'
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# The open tracking issue's number, or nothing. Listed, not searched: the search index lags.
issue=$(gh issue list --state open --limit 500 --json number,title \
  | jq -r --arg title "$TITLE" '.[] | select(.title == $title) | .number' | head -n 1)

if [[ $OUTCOME == success ]]; then
  if [[ -n $issue ]]; then
    gh issue comment "$issue" --body "Green again in $RUN_URL: closing."
    gh issue close "$issue"
    echo "WebKit nightly green: closed #$issue"
  else
    echo 'WebKit nightly green: no tracking issue open'
  fi
  exit 0
fi

# Every test that failed after its retries, one line each, sorted so runs compare.
: >"$WORK/failing"
for results in "$RESULTS_DIR"/*/results.json; do
  [[ -e $results ]] || continue
  jq -r '
    [.suites[]? | recurse(.suites[]?) | .specs[]? | . as $spec
      | .tests[] | select(.status == "unexpected")
      | "- `\(.projectName)` test/\($spec.file):\($spec.line) › \($spec.title)"]
    | .[]' "$results" >>"$WORK/failing"
done
sort -u -o "$WORK/failing" "$WORK/failing"
count=$(grep -c '' "$WORK/failing" || true)
if [[ $count -eq 0 ]]; then
  echo '- No test failed: the run stopped before a suite finished (install, build or a timeout). See the run.' >"$WORK/failing"
fi

{
  echo 'The nightly Playwright run in WebKit (`nightly.yml`, job `webkit`: the `webkit` and `Mobile Safari` projects) is red. The owner uses the app on an iPhone, where every browser is WebKit; the PR gate runs Chromium only.'
  echo
  echo "Last run: $RUN_URL ($count failing)"
  echo
  echo '### Failing'
  echo
  cat "$WORK/failing"
  echo
  echo 'Each is an app bug on Safari or a spec WebKit cannot run (`docs/testing-webkit.md` says which is which). This issue is updated by every red run and closes itself on the next green one.'
} >"$WORK/body"

if [[ -z $issue ]]; then
  gh issue create --title "$TITLE" --body-file "$WORK/body"
  echo "WebKit nightly red ($count failing): opened the tracking issue"
  exit 0
fi

gh issue view "$issue" --json body -q .body | grep -E '^- ' | sort -u >"$WORK/before" || true
gh issue edit "$issue" --body-file "$WORK/body"
if ! diff -q "$WORK/before" "$WORK/failing" >/dev/null; then
  {
    echo "The failing specs changed in $RUN_URL:"
    echo
    comm -13 "$WORK/before" "$WORK/failing" | sed 's/^- /- now failing: /'
    comm -23 "$WORK/before" "$WORK/failing" | sed 's/^- /- no longer failing: /'
  } >"$WORK/comment"
  gh issue comment "$issue" --body-file "$WORK/comment"
fi
echo "WebKit nightly red ($count failing): updated #$issue"
