# closet's gate plan, sourced by devkit/bin/local_gate.sh (contract in its header). devkit's
# default plan (devkit/bin/_paths_lib.sh) owns the area groups; closet adds only the rules the
# fleet table cannot express. Every job is a Makefile target ci.yml also calls.
#
#   docs only (*.md, docs/**)          -> docs (docs-check), no npm ci
#   tooling only (devkit/ guards and   -> deps + quick; + image when devkit's contract probe or
#     gate machinery, .devkit-rev, ...)   boot script changed (devkit's IMAGE group)
#   anything else ("other": closet's      -> deps + quick, then closet's own rules
#     src/ and test/ lie outside the       (gate_plan_extra), per path:
#     fleet's backend/frontend dirs)
#       LICENSE, .github/**             -> nothing more (Actions files; no gate job reads them)
#       docs/metrics/ratchet.json,      -> + db (the cov collector reads its coverage report)
#         scripts/ci/metrics.conf
#       test/integration/**             -> + db
#       test/support/**                 -> + db + e2e: scratch-database.ts and the integration
#                                          globalSetup, which both tiers import
#       other test/** (Playwright)      -> + e2e
#       anything else                   -> + db + e2e (src, views, public, drizzle, scripts,
#                                          package*.json, configs, Makefile, devkit/ job scripts)
#   image-affecting paths              -> + image (ci-image, then ci-smoke)
#   any non-docs path                  -> + metrics (ci-metrics, devkit's METRICS group, last)
#
# db and e2e live in gate_plan_extra, not the BACKEND/E2E groups: closet's whole app is the
# fleet's "other", and an area group would run both tiers for a Playwright-only or .github-only
# change. Order: deps, quick, image, db, e2e, metrics (the default plan runs its groups, then the
# extra, then METRICS).
# Public repo: GATE_ALLOW_FORKS stays at the skeleton's 0, so a fork PR never runs here.
# shellcheck disable=SC2034  # read by the sourcing skeleton and devkit_default_gate_plan
GATE_SLUG=agandhi4/closet
# shellcheck disable=SC2034
GATE_STATE_NAME=closet-gate

PG_CONTAINER="closet-gate-pg-$PR"
SMOKE_PG_CONTAINER="closet-gate-smoke-pg-$PR"
IMAGE="closet:gate-$PR"

# deps first: ci-quick's check:static and every test tier need node_modules, and QUICK runs
# for every area that can run db or e2e (gate_plan_extra checks that anyway).
# shellcheck disable=SC2034
GATE_JOBS_QUICK="deps ci-deps|quick ci-quick"
# shellcheck disable=SC2034
GATE_JOBS_DOCS="docs docs-check"
# The build, then the image booted on its own throwaway Postgres (scripts/smoke-image.sh:
# /health/ready names CI_BUILD_VERSION, the observability contract probe): what ci.yml's publish
# job runs on the bytes it pushes, proved here before the merge.
# shellcheck disable=SC2034
GATE_JOBS_IMAGE="image ci-image ci-smoke CI_IMAGE=$IMAGE CI_BUILD_VERSION=gate-$PR SMOKE_PG_CONTAINER=$SMOKE_PG_CONTAINER"
# Only these paths change what the production image installs or how it builds; any other change
# reaches the image only through `npm run build`, which the e2e job runs.
# shellcheck disable=SC2034
GATE_AREAS_IMAGE=""
# shellcheck disable=SC2034
GATE_IMAGE_PATHS='^(Dockerfile$|package(-lock)?\.json$|\.npmrc$|patches/)'

# The metrics ratchet, last so it merges every earlier job's seconds (devkit owns the label and
# which collectors run: devkit/bin/_paths_lib.sh, METRICS).
# shellcheck disable=SC2034
GATE_JOBS_METRICS="metrics ci-metrics"

gate_cleanup() {
  "$ROOT/devkit/bin/throwaway_pg.sh" down "$PG_CONTAINER"
  "$ROOT/devkit/bin/throwaway_pg.sh" down "$SMOKE_PG_CONTAINER"
  docker rmi -f "$IMAGE"
}

gate_plan() { devkit_default_gate_plan; }

gate_plan_extra() {
  local db=0 e2e=0 path
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    # docs, tooling and native paths are the default plan's; the rest is closet's layout.
    case "$(devkit_classify_path "$path")" in docs|tooling|native) continue ;; esac
    case "$path" in
      LICENSE|.github/*) ;;
      # The ratchet's bounds and collectors (other since devkit f6bf01f): db, so the cov
      # collector (job:db) measures instead of SKIPPING; no browser can see them.
      docs/metrics/ratchet.json|scripts/ci/metrics.conf) db=1 ;;
      test/support/*) db=1; e2e=1 ;;
      test/integration/*) db=1 ;;
      test/*) e2e=1 ;;
      *) db=1; e2e=1 ;;
    esac
  done <<< "$CHANGED"
  echo "GATE scope db=$db e2e=$e2e"

  # Unreachable while QUICK keeps its default areas; kept so a narrowed QUICK cannot run a
  # test tier without node_modules.
  if [ "$db$e2e" != 00 ] && ! devkit_group_ran quick; then job deps ci-deps; fi

  # 21 integration specs bind 127.0.0.2 (test/integration/link-sites.ts); without the alias
  # they fail with EADDRNOTAVAIL, which reads like a code failure.
  if [ "$db" = 1 ] && [ "$(uname -s)" = Darwin ] && ! ifconfig lo0 | grep -q 'inet 127\.0\.0\.2 '; then
    note "127.0.0.2 missing on lo0 (sudo ifconfig lo0 alias 127.0.0.2); the db job will fail"
  fi

  if [ "$db" = 1 ]; then
    job db ci-db PG_CONTAINER="$PG_CONTAINER"
  else
    skip db "no source, integration or test-support changes"
  fi

  if [ "$e2e" = 1 ]; then
    job e2e ci-e2e PG_CONTAINER="$PG_CONTAINER"
  else
    skip e2e "no source, Playwright or test-support changes"
  fi
}
