#!/usr/bin/env bash
# Holds a test tier to its wall-clock budget (owner directive 2026-10-13: unit <= 60 s, db <= 180 s,
# e2e <= 180 s on the developer machine; docs/decisions.md, Lean test suite). Runs the command,
# then prints `budget <tier> ok (<n>s of <b>s)` or `budget <tier> OVERBUDGET (<n>s > <b>s)` and
# fails. A command that fails on its own fails with its own code before the budget is judged.
#
# Usage: scripts/ci/budget.sh <tier> <budget-seconds> -- <command...>
# CI_BUDGET_ENFORCE=0 keeps the line but not the failure (a box adopting budgets, a loaded laptop);
# the gate's own per-job budget (devkit local_gate.sh, GATE_JOB_BUDGET_MINUTES) is separate and
# bounds the whole job, build and container included.
set -uo pipefail

[ $# -ge 4 ] && [ "$3" = -- ] || { echo "usage: $0 <tier> <budget-seconds> -- <command...>" >&2; exit 2; }
tier=$1
budget=$2
shift 3
[[ "$budget" =~ ^[0-9]+$ ]] || { echo "budget: budget-seconds must be an integer (got '$budget')" >&2; exit 2; }

start=$SECONDS
"$@"
rc=$?
secs=$((SECONDS - start))
[ "$rc" = 0 ] || { echo "budget $tier: command failed (exit $rc) after ${secs}s"; exit "$rc"; }
if [ "$secs" -gt "$budget" ]; then
  echo "budget $tier OVERBUDGET (${secs}s > ${budget}s)"
  [ "${CI_BUDGET_ENFORCE:-1}" = 0 ] || exit 1
  echo "budget $tier: over budget, not enforced (CI_BUDGET_ENFORCE=0)"
else
  echo "budget $tier ok (${secs}s of ${budget}s)"
fi
