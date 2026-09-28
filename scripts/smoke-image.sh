#!/usr/bin/env bash
# Boots a built image as production runs it (`node dist/main.js`, NODE_ENV=production, the PWA on)
# and checks it serves, so a broken Dockerfile or a runtime dependency that no longer loads blocks the
# publish instead of reaching the homelab (#181). The unit and integration tiers never boot main.ts
# or server.ts: this is their test (vitest.config.ts leaves them out of coverage for it).
#
#   ci.yml, publish:     before the image is pushed, with a placeholder model
#   nightly.yml, cutout: with the real BiRefNet model (MODELS_DIR), plus one real cutout
#
# Usage: scripts/smoke-image.sh <image>
# Environment:
#   DATABASE_HOST, DATABASE_PORT (5432), DATABASE_USER, DATABASE_PASS, DATABASE_SCHEMA
#       An empty database: the boot must apply the migrations. The container runs on the host's
#       network, so localhost is the host's (CI's Postgres service, pgvault-dev on linux-box).
#   SMOKE_PORT   where the app listens (3000).
#   MODELS_DIR   a directory holding the verified model (npm run cutout:fetch-model): the app loads it
#                and an uploaded photo must get its cutout. Unset: a placeholder file stands in, which
#                the app refuses on its checksum, so the boot never downloads 940 MB.
#
# Checks, each fatal: /healthz answers; the boot log shows the migrations applied; the login page
# renders in the app shell and its stylesheet and htmx are served; with MODELS_DIR, a photo uploaded
# over HTTP is cut out by the model in the image's own onnxruntime; `docker stop` (SIGTERM) exits 0.
# On failure the container's log is printed.
set -euo pipefail

# Match against a snapshot of the container log, never `docker logs | grep -q`: with pipefail,
# grep -q exits on its first match, docker logs dies of SIGPIPE, and the pipeline reports a
# failure for text that was found (the first publish run on main failed this way, 2026-09-28).
log_has() { docker logs "$NAME" >"$WORK/container.log" 2>&1; grep -q "$@" "$WORK/container.log"; }

IMAGE=${1:?usage: scripts/smoke-image.sh <image>}
: "${DATABASE_HOST:?} ${DATABASE_USER:?} ${DATABASE_SCHEMA:?}"
PORT=${SMOKE_PORT:-3000}
BASE="http://127.0.0.1:$PORT"
NAME="closet-smoke-$$"
WORK=$(mktemp -d)
BOOT_TIMEOUT_S=60
CUTOUT_TIMEOUT_S=240

log() { echo "[smoke $(date -u +%H:%M:%S)] $*"; }
fail() {
  log "FAIL: $*"
  echo "----- container log ($NAME) -----"
  docker logs "$NAME" 2>&1 | tail -n 200 || true
  exit 1
}
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# The same keypair shape production has, made by the image's own web-push (PWA_ENABLED requires them).
keys=$(docker run --rm --entrypoint /app/node_modules/.bin/web-push "$IMAGE" generate-vapid-keys --json)

if [ -n "${MODELS_DIR:-}" ]; then
  models=$(cd "$MODELS_DIR" && pwd)
else
  models="$WORK/models"
  mkdir -p "$models"
  echo "placeholder: refused on its checksum" >"$models/birefnet_512.onnx"
fi

log "starting $IMAGE on :$PORT (database $DATABASE_SCHEMA on $DATABASE_HOST, model: ${MODELS_DIR:-placeholder})"
started=$SECONDS
docker run -d --name "$NAME" --network host \
  -v "$models:/app/models:ro" \
  -e PORT="$PORT" \
  -e DATABASE_HOST="$DATABASE_HOST" \
  -e DATABASE_PORT="${DATABASE_PORT:-5432}" \
  -e DATABASE_USER="$DATABASE_USER" \
  -e DATABASE_PASS="${DATABASE_PASS:-}" \
  -e DATABASE_SCHEMA="$DATABASE_SCHEMA" \
  -e ACCESS_TOKEN_SECRET=smoke-test-access-token-secret-not-for-deployment \
  -e PWA_ENABLED=true \
  -e SITE_URL=https://closet.test \
  -e PUBLIC_VAPID_KEY="$(jq -r .publicKey <<<"$keys")" \
  -e PRIVATE_VAPID_KEY="$(jq -r .privateKey <<<"$keys")" \
  "$IMAGE" >/dev/null

until [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/healthz")" = 204 ]; do
  [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = true ] || fail "the container exited during boot"
  [ $((SECONDS - started)) -lt $BOOT_TIMEOUT_S ] || fail "/healthz did not answer 204 within ${BOOT_TIMEOUT_S}s"
  sleep 1
done
log "ok: /healthz 204 after $((SECONDS - started))s"

migrated=$(docker logs "$NAME" 2>&1 | grep -oE 'Applied [0-9]+ Drizzle migration\(s\)' || true)
[ -n "$migrated" ] || fail "the boot log does not show the migrations applied (was the database empty?)"
log "ok: $migrated"

page="$WORK/login.html"
status=$(curl -s -o "$page" -w '%{http_code}' "$BASE/auth/login")
[ "$status" = 200 ] || fail "GET /auth/login answered $status"
# The layout (src/web/layout/layout.tsx): the app name in the title, the boosted body.
grep -qE '<title>[^<]*Closet</title>' "$page" || fail "the login page's <title> does not name the app"
grep -q '<body hx-boost="true"' "$page" || fail "the login page is not in the app shell (no boosted <body>)"
grep -q 'name="password"' "$page" || fail "the login page has no sign-in form"
css=$(grep -oE '/bundle\.css\?v=[^"]+' "$page" | head -n 1)
[ -n "$css" ] || fail "the login page links no /bundle.css"
for asset in "$css" /modules/htmx.min.js; do
  status=$(curl -s -o /dev/null -w '%{http_code}' "$BASE$asset")
  [ "$status" = 200 ] || fail "GET $asset answered $status"
done
log "ok: /auth/login 200 in the app shell; $css and /modules/htmx.min.js served"

if [ -n "${MODELS_DIR:-}" ]; then
  # A red shirt on a pale backdrop, drawn by the image's own sharp.
  docker run --rm --entrypoint node "$IMAGE" -e "
    const shirt = Buffer.from('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1200\" height=\"1600\"><path d=\"M380 300 L520 240 Q600 300 680 240 L820 300 L960 520 L840 600 L820 540 L820 1300 L380 1300 L380 540 L360 600 L240 520 Z\" fill=\"#b3262a\"/></svg>');
    require('sharp')({ create: { width: 1200, height: 1600, channels: 3, background: '#ece8e1' } })
      .composite([{ input: shirt }]).jpeg({ quality: 90 }).toBuffer()
      .then((jpeg) => process.stdout.write(jpeg));
  " >"$WORK/photo.jpg"

  password=Smoke-test-1
  cookie=$(curl -s -o /dev/null -D - -H "Origin: $BASE" \
    --data-urlencode email=smoke@closet.invalid --data-urlencode password=$password \
    --data-urlencode confirmPassword=$password "$BASE/auth/register" |
    grep -oiE '^set-cookie: access_token=[^;]+' | sed -E 's/^[^:]+: //')
  [ -n "$cookie" ] || fail "registering the smoke account set no session"

  location=$(curl -s -o /dev/null -w '%{redirect_url}' -H "Origin: $BASE" -H "Cookie: $cookie" \
    --data-urlencode 'name=Smoke shirt' --data-urlencode category=shirt "$BASE/wardrobe")
  garment=$(grep -oE '/wardrobe/[0-9]+' <<<"$location" | grep -oE '[0-9]+$' || true)
  [ -n "$garment" ] || fail "creating a garment redirected to '$location'"

  status=$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: $BASE" -H "Cookie: $cookie" \
    -F "photo=@$WORK/photo.jpg;type=image/jpeg" "$BASE/wardrobe/$garment/photo")
  [ "$status" = 303 ] || fail "uploading the photo of garment $garment answered $status"
  log "uploaded a photo to garment $garment; waiting for its cutout"

  queued=$SECONDS
  until log_has "Cutout ready: garment $garment "; do
    if log_has -E "Cutout (failed|discarded)[^:]*: garment $garment "; then
      fail "the model did not cut out garment $garment's photo"
    fi
    [ $((SECONDS - queued)) -lt $CUTOUT_TIMEOUT_S ] || fail "no cutout for garment $garment within ${CUTOUT_TIMEOUT_S}s"
    sleep 2
  done
  log "ok: $(docker logs "$NAME" 2>&1 | grep -oE "Cutout ready: garment $garment [^[:cntrl:]]*" | head -n 1)"
fi

docker stop -t 15 "$NAME" >/dev/null
code=$(docker inspect -f '{{.State.ExitCode}}' "$NAME")
[ "$code" = 0 ] || fail "docker stop: the process exited $code, not 0"
log_has 'SIGTERM: shutting down' || fail "the log does not show the SIGTERM shutdown"
log "ok: SIGTERM shut it down with exit 0"
log "PASS $IMAGE in $((SECONDS - started))s"
