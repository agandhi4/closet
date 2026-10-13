# closet's gate plan, sourced by devkit/bin/local_gate.sh (contract in its header).
# Which jobs run for which changed paths; every job is a Makefile target ci.yml also calls.
#
#   always                             -> deps + quick (docs-check covers *.md, so never nothing_to_run)
#   *.md, docs/**, LICENSE, .github/** -> quick only
#   test/integration/**                -> + db
#   test/support/**                    -> + db + e2e: it holds scratch-database.ts and the
#                                         integration globalSetup, which the old gate's "other
#                                         test/** is browser only" rule let skip the db job
#   other test/** (Playwright specs)   -> + e2e
#   anything else                      -> + db + e2e (src, views, public, drizzle, scripts,
#                                         package*.json, configs, Makefile, devkit/)
#   image-affecting paths              -> + image (ci-image, then ci-smoke)
# Public repo: GATE_ALLOW_FORKS stays at the skeleton's 0, so a fork PR never runs here.
# shellcheck disable=SC2034  # read by the sourcing skeleton
GATE_SLUG=agandhi4/closet
# shellcheck disable=SC2034
GATE_STATE_NAME=closet-gate

# Paths that change what the production image installs or how it builds. Any other change
# reaches the image only through `npm run build`, which the e2e job runs.
IMAGE_PATHS='^(Dockerfile$|package(-lock)?\.json$|\.npmrc$|patches/)'

PG_CONTAINER="closet-gate-pg-$PR"
SMOKE_PG_CONTAINER="closet-gate-smoke-pg-$PR"
IMAGE="closet:gate-$PR"

gate_cleanup() {
  "$ROOT/devkit/bin/throwaway_pg.sh" down "$PG_CONTAINER"
  "$ROOT/devkit/bin/throwaway_pg.sh" down "$SMOKE_PG_CONTAINER"
  docker rmi -f "$IMAGE"
}

gate_plan() {
  local db=0 e2e=0 path
  while IFS= read -r path; do
    [ -z "$path" ] && continue
    case "$path" in
      *.md|docs/*|LICENSE|.github/*) ;;
      test/support/*) db=1; e2e=1 ;;
      test/integration/*) db=1 ;;
      test/*) e2e=1 ;;
      *) db=1; e2e=1 ;;
    esac
  done <<< "$CHANGED"
  echo "GATE scope db=$db e2e=$e2e"

  # 21 integration specs bind 127.0.0.2 (test/integration/link-sites.ts); without the alias
  # they fail with EADDRNOTAVAIL, which reads like a code failure.
  if [ "$db" = 1 ] && [ "$(uname -s)" = Darwin ] && ! ifconfig lo0 | grep -q 'inet 127\.0\.0\.2 '; then
    note "127.0.0.2 missing on lo0 (sudo ifconfig lo0 alias 127.0.0.2); the db job will fail"
  fi

  job deps ci-deps
  job quick ci-quick

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

  # The build, then the image booted on its own throwaway Postgres (scripts/smoke-image.sh:
  # /health/ready names CI_BUILD_VERSION, the observability contract probe): what ci.yml's publish
  # job runs on the bytes it pushes, proved here before the merge.
  if changed "$IMAGE_PATHS"; then
    job image ci-image ci-smoke CI_IMAGE="$IMAGE" CI_BUILD_VERSION="gate-$PR" SMOKE_PG_CONTAINER="$SMOKE_PG_CONTAINER"
  else
    skip image "no Dockerfile, dependency or patch changes"
  fi
}
