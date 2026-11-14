#!/usr/bin/env bash
# Keeps ONE tracking issue in step with whether the nightly (nightly.yml) runs at all: it opens
# or updates the issue when no scheduled run has COMPLETED in the last 48 hours, and closes it
# once one has. webkit-nightly-issue.sh reports a red nightly; this reports one that never
# started (an invalid workflow file, disabled Actions, an exhausted budget), which is silent
# otherwise: #635. Run by nightly-watchdog.yml, a file of its own so a broken nightly.yml
# cannot take the check down with it.
#
# Usage: scripts/nightly-staleness.sh
# Environment:
#   GH_TOKEN, GH_REPO   for gh: actions: read and issues: write, owner/repo
#   RUN_URL             the watchdog run, linked from the issue
#   NOW_EPOCH           optional, seconds since the epoch: the clock, for the unit spec
# A completed run is any scheduled run that finished as success or failure; a red one is
# webkit-nightly-issue.sh's to report. Push runs and cancelled or skipped runs do not count.

# The issue's backticks are Markdown, not command substitutions.
# shellcheck disable=SC2016
set -euo pipefail

: "${RUN_URL:?}" "${GH_REPO:?}"
WINDOW_HOURS=48
TITLE="Nightly has not completed a scheduled run in $WINDOW_HOURS hours"
NOW=${NOW_EPOCH:-$(date -u +%s)}

# Newest first; the most recent completed scheduled run is all that is needed.
last=$(gh run list --workflow nightly.yml --event schedule --status completed --limit 20 \
  --json conclusion,updatedAt \
  | jq -r '[.[] | select(.conclusion == "success" or .conclusion == "failure") | .updatedAt] | max // empty')

issue=$(gh issue list --state open --limit 500 --json number,title \
  | jq -r --arg title "$TITLE" '.[] | select(.title == $title) | .number' | head -n 1)

if [[ -n $last ]]; then
  age_hours=$(((NOW - $(jq -nr --arg t "$last" '$t | fromdateiso8601')) / 3600))
else
  age_hours=-1
fi

if [[ -n $last && $age_hours -lt $WINDOW_HOURS ]]; then
  if [[ -n $issue ]]; then
    gh issue comment "$issue" --body "A scheduled nightly completed at $last: closing."
    gh issue close "$issue"
    echo "Nightly fresh (last completed $last): closed #$issue"
  else
    echo "Nightly fresh (last completed $last): no tracking issue open"
  fi
  exit 0
fi

if [[ -n $last ]]; then
  since="The last scheduled run completed at $last (${age_hours} hours ago)."
else
  since='No scheduled run has completed in the recent history.'
fi
body=$(
  echo 'No scheduled `nightly.yml` run has completed in the last 48 hours: the WebKit run (the owner'"'"'s phone engine), the page audit, Lighthouse and the real cutout model are not being checked.'
  echo
  echo "$since Checked by $RUN_URL"
  echo
  echo 'Usual causes: the workflow file is invalid (`make actionlint-check` should have stopped it), Actions is disabled or out of minutes, or the schedule was paused after 60 days without a push. Run `gh workflow run nightly.yml` to see whether it parses. This issue is updated by every check and closes itself once a scheduled run completes.'
)

if [[ -z $issue ]]; then
  gh issue create --title "$TITLE" --body "$body"
  echo "Nightly stale (last completed: ${last:-never}): opened the tracking issue"
else
  gh issue edit "$issue" --body "$body"
  echo "Nightly stale (last completed: ${last:-never}): updated #$issue"
fi
