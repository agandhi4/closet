# Deployment

What applies to any install: the env, permissions, health, recovery and publishing. The owner's production (the production host in the homelab, its hosts, paths, DNS, proxies and the public MCP host) is documented in the private homelab repo, `stacks/closet/README.md`, never here: this repo is public (2026-11-12, "Homelab topology lives in the homelab repo"; `make docs-check` and `make devkit-check` refuse it).

| Piece | Value |
| --- | --- |
| URL | `SITE_URL`, HTTPS: the PWA (service worker, push) needs a secure context. A plain-HTTP twin serves pages but no service worker |
| Image | `ghcr.io/kashhq/closet:latest`, amd64, published by the owner's publisher (CI and publishing) once main is green and the image boots |
| Container | port 3000, uid 1000 (Permissions), about 5 GB of memory (the model child's native memory is outside Node's heap) |
| Database | PostgreSQL 18, one database and role for closet (`DATABASE_*`, README Configuration) |
| Photos | `DATA_PATH`, a host mount writable by uid 1000; a network share works (production's is NFS) |
| Model | `MODELS_PATH`, local disk (BiRefNet 512, downloaded and checksum-verified at first boot) |
| Public MCP | optional: a reverse proxy that forwards only `POST /mcp` and 404s everything else (README, Connect your Claude). The personal access token is the only gate |

The env, as production sets it (values never in this repo or printed; the file is mode 600):

```
SITE_URL=https://<host>
DISABLE_REGISTRATION=true          # flip to false only while creating household accounts
ACCESS_TOKEN_SECRET=<openssl rand -hex 32>        # required, 32+ chars
PUBLIC_VAPID_KEY=<npx web-push generate-vapid-keys>   # required when PWA_ENABLED=true
PRIVATE_VAPID_KEY=<same>
CLOSET_DB_HOST=<postgres host>
CLOSET_DB_PORT=<postgres port>
CLOSET_DB_PASSWORD=<the closet role's password>
CLOSET_DATA_DIR=<host directory for DATA_PATH>
CLOSET_MODELS_DIR=<host directory for MODELS_PATH>
CLOSET_WEB_NETWORK=<the reverse proxy's Docker network>
TRUSTED_PROXIES=<that network's subnet>   # the proxy is the edge, so X-Forwarded-For is the real client
METRICS_ENABLED=true               # GET /metrics on the Docker network; src/metrics/AGENTS.md
SENTRY_DSN=http://<key>@<bugsink host>/<project id>   # unset or empty: error tracking off
ORDER_MAIL_JMAP_TOKEN=<Fastmail API token, Email read-only>   # order email import (#25); unset or empty: off
ORDER_MAIL_SENDERS=<the owner's addresses, comma-separated>
ORDER_MAIL_OWNER=<the owner's closet sign-in email>
# ORDER_MAIL_POLL_MINUTES defaults to 5
# APP_TIMEZONE defaults to America/New_York in the compose file
```

**Error tracking.** `SENTRY_DSN` is the DSN of closet's project in a Bugsink (Sentry-compatible; Bugsink shows it on the project's page). The container must reach its host: the boot log says `Error tracking: on (<host>, release <sha7>, environment production)`, and a `Could not send an event to Bugsink` warning (logger `ErrorTracking`) means it cannot. Each event's `release` is the image's `APP_VERSION`, the bare 7-char sha: the publisher passes it as a build arg, the Dockerfile's final stage bakes it in as env and as the `org.opencontainers.image.version` label, and `src/build-info.ts` resolves it once at boot (`BuildInfo.release`), so `/health/ready`, the pages' beacon and the server report the same release, the one the image tag `sha-<7>` names with its prefix. Its `environment` is `APP_ENV`: `production` by default, `gate` in the smoke test, `dev` for `npm run start:dev` and the tests. Compose never sets it. A local `npm run build` names its release from `git rev-parse HEAD` (`public/build.json`); without either (`start:dev`, the tests) it is `dev`. What is captured and how it is scrubbed: `src/metrics/AGENTS.md`, Error tracking.

**Order email import** (#25; `src/web/wardrobe/order-mail.md`). Off until the token is set. The owner's steps, once:

1. Create a Fastmail account used for nothing else (the order address). Closet only ever reads it.
2. In that account, Settings › Privacy & Security › Manage API tokens › New API token ([Fastmail's help](https://www.fastmail.help/hc/en-us/articles/5254602856719-API-tokens)). Give it **Email** access only, tick **Read-only access**, and leave every other scope (contacts, calendars, sending, masked email) unticked. Copy the token (`fmu1-…`): Fastmail shows it once.
3. Put the token and the owner's addresses in `closet.env` (above): `ORDER_MAIL_SENDERS` lists every address the owner forwards from, and `ORDER_MAIL_OWNER` is the email the owner signs in to closet with. The homelab compose file must pass the three variables through to the container. Redeploy.
4. Forward an order confirmation **by hand** to the order address (an auto-forward rule keeps the retailer as From and is ignored). Within `ORDER_MAIL_POLL_MINUTES` its products show under Wardrobe › ⋯ › From your orders.

The boot log says `Order mail: on (Fastmail, every 5 min, N trusted senders)`; each poll logs one line (logger `OrderMail`), and each ignored email says why (`untrusted (sender-not-allowed, from <domain>)`). A failing poll (a revoked token is `JMAP session refused (http-status 401)`) counts as `job_duration_seconds{name="order_mail",outcome="failure"}` and reaches Bugsink; the token never appears in logs or events. To turn it off, unset the token and redeploy; the review list's rows stay. To rotate, create a new token, swap it in, redeploy, then revoke the old one in Fastmail.

**Trusted proxies.** `TRUSTED_PROXIES` must include the address Caddy connects from (Request security). Check with the boot log line `Trusted proxies: ...` and a rate-limit hit's `for <ip>` warning: it must name the client, not Caddy.

**Demo login.** `docker exec closet npm run seed -- --persona demo --share-with <owner email>` seeds Theo (a random password, printed once; registration stays disabled, the CLI inserts the user) and shares his wardrobe with the owner's account. `--reset` (with `--share-with` again) after the bible changes; `--persona demo --remove` takes it out, and `npm run maintenance:reconcile -- --dry-run` then reports nothing. The hourly autoupdate never reseeds. A forgotten password: `user:set-password -- demo@closet.invalid`.

**Trimmed thumbs (#373), once.** After the deploy that trims new cutouts' thumbs to the garment, on the host: `docker exec closet npm run maintenance:retrim-thumbs -- --dry-run` (counts the thumbs `due`), then without `--dry-run`. Each photo with a ready or edited cutout gets its trimmed thumb under a new variant key, so phones fetch it; the replaced files go with the swap. A second run reports them `current`. Exit 1 names failed photos in warn lines (logger `ThumbRetrim`); run it again. src/maintenance/AGENTS.md, Commands.

**Locked out.** There is no email reset. On the host: `docker exec -it closet npm run user:set-password -- <email>` asks for the new password twice without echoing it (or reads it from piped stdin), applies the registration rules, and signs out every session of that account (its access tokens and push subscriptions revoked with them). An unknown email exits 1 and changes nothing, and so does a database the running build has not migrated yet (it never migrates).

**One container at a time.** `container_name: closet` makes `docker compose up -d` stop and remove the old container before the new one starts, so two builds never serve or write photos together (the new one migrates at boot). **Rolling back past #141** (the variant-key cutouts, `drizzle/0027`) is not free: the older build serves only unkeyed cutout names, and every cutout made or edited since was stored keyed with its unkeyed predecessor deleted, so those photos show their original until cut again; a mask edit the older build saves bumps the version without touching `variant_key`, so the newer build, back again, serves the key's older mask. After such a round trip, `update file set variant_key = null where variant_key is not null and file_name in (...)` for the photos edited meanwhile, then re-cut or re-edit them.

**Rotating the secret.** Set a new `ACCESS_TOKEN_SECRET` (`openssl rand -hex 32`) in `closet.env`, redeploy, then `docker exec closet npm run push:revoke-all`: the rotation signed everyone out, and a device left closed would otherwise keep receiving its account's reminders until it next opened the app (the login page drops its browser subscription then). After the restart, not before: a session still open re-sends its subscription on its next page. Everyone signs in again and re-enables notifications and reminders on the profile. Personal access tokens are unaffected (Request security, Session revocation).

Deploy now, data fixes and production's paths: homelab `stacks/closet/README.md`.

## Permissions

The image runs as `node`, **uid/gid 1000** (the Dockerfile's `USER`), never root. It writes exactly two directories, both host mounts in production, and a mount keeps the host's ownership, so both must be writable by uid 1000 on the host:

| In the container | What writes it |
| --- | --- |
| `/app/data` (`DATA_PATH`) | photos, `.incoming/`, `app.log` |
| `/app/models` (`MODELS_PATH`) | the model's download at first boot |

```bash
# On the host, as root: give uid 1000 both directories (a root-owned one is what the root image's
# download left). A network share that squashes every client user may refuse the chown and not need it.
sudo chown -R 1000:1000 <data dir> <models dir>
# Prove both as uid 1000 with the image itself:
docker run --rm --user 1000:1000 -v <data dir>:/d -v <models dir>:/m --entrypoint sh \
  ghcr.io/kashhq/closet:latest -c 'for d in /d /m; do touch $d/.probe && rm $d/.probe || exit 1; done; echo writable'
```

**The symptom** of a directory uid 1000 cannot write: a root-owned `/app/data` ends the boot (the container restarts in a loop) with the fatal line `DATA_PATH /app/data is not writable by this process (EACCES): chown -R 1000:1000 the host directory mounted at /app/data; docs/operations.md#permissions`, before anything else is logged. A root-owned `/app/models` boots and serves pages, but `/health/ready` answers 503 with `storage` down and that chown as its `fix`, the container goes unhealthy and autoheal restarts it, and the model download fails (`Downloading BiRefNet 512x512 failed`, `EACCES`). A directory that stops being writable later (the NFS share remounted read-only) shows the same `storage` check within 5 s. `docker exec closet ...` runs as uid 1000 too (`npm` caches under `/home/node`).

## Health

`GET /health/live` checks nothing (the phones' connectivity heartbeat). `GET /health/ready` (alias `/healthz`) is what the image's `HEALTHCHECK` (every 30 s, 60 s start period), the smoke boot and devkit's contract probe read: 200 `{"status": "up", "version": "<sha7>", "checks": {...}}`, or 503 `"down"` when a required check is down. It is limited to 60 a minute per address. Each down check names this section as its `fix`, and the log line (logger `Health`, `Readiness: ...`) says why:

- **`database`** (required): the pool's one statement did not answer in 3 s or failed. Check the Postgres server and `CLOSET_DB_HOST`; the app recovers by itself once it answers.
- **`migrations`** (required): the database's newest Drizzle migration is older than this build's, so it was restored or repointed after the boot. Restart the container: the boot migrates.
- **`storage`** (required): a directory the process writes (`DATA_PATH`, `MODELS_PATH`) refused a create and unlink as uid 1000; its `fix` is the chown and the log line names the directory and the error code. Probed at most once every 5 s: see Permissions.
- **`cron_jobs`** (optional): a timer's run has been in flight over 30 minutes (`stuck` names it). Its last `cron-` lines in Loki say where it hangs; a restart starts it afresh.
- **`cutout_queue`** (optional): the background-removal queue is not running. In production that means the process is shutting down.

Optional checks never make the app down: every page still serves while one is down, and a restart loop would cost the household the app. Compose inherits the image's `HEALTHCHECK`; without a restarter (an `autoheal` container, or an orchestrator) an unhealthy container is only marked, never restarted.

## CI and publishing

- **No pre-merge gate; main is proven at deploy** (devkit 2026-11-02): a PR merges on review rounds (`@codex review`, or `make review PR=<n>`, then `make merge PR=<n>`). The publisher below runs every job of `scripts/ci/gate_plan.sh` on main (`devkit/bin/check_tree.sh`: the Makefile's `ci-quick`, `ci-db`, `ci-e2e`, `ci-image` and `ci-smoke`, each on its own throwaway Postgres 18 container) before it ships. The browser job runs with the PWA on, as production does; specs sign in through `test/support/e2e-session.ts`. `ci.yml`'s manual jobs (`workflow_dispatch`, its only trigger) call the same make targets.
- **The publisher host publishes** (2026-10-28, one fleet publisher; devkit README "Publish"): homelab's `devkit-publish@closet.timer` runs `make publish` (`devkit/bin/publish.sh`) against a clone kept at `main`. At most once per 3 h window, when main moved, check_tree runs the whole plan on a clean worktree; a red commit files a `main-red` issue and never ships. A green commit that touches no image input (the plan's IMAGE group: `scripts/ci/gate_plan.sh`'s `GATE_IMAGE_EXCLUDE_PATHS`, docs) is recorded as checked, with no push and no tag. Otherwise it builds the newest green `main` (`make ci-image`, native amd64; it refuses any other host), boots it (`make ci-smoke`), pushes `sha-<7>` and points `latest` at the same digest, creates the git tag `ship-<YYYY-MM-DD>-<sha7>` (`devkit/bin/ship_tag.sh`; idempotent, refuses a sha not on `main`) and prunes GHCR to the 10 newest `sha-*` images (`devkit/bin/registry_prune.sh`; never the one `latest` names). Pushing `latest` is the deploy, so the publisher alone moves it, and never backward. Never publish from the Mac (an arm64 image cannot run on the production host); the owner's urgent path on the publisher host is `devkit/bin/publish.sh . --recheck origin/main`, or `--ungated '<reason>'`. Semver releases (`tag-release.yml`, `release/X.Y.Z` branches) and date tags are retired (2026-10-13). Until 2026-10-28 `ci.yml`'s `publish` job did this on Actions. Merging to main is deploying: the homelab autoupdater redeploys within the hour.
- **The image is booted before it is pushed** (#181). The publisher builds it once into the publisher host's Docker (`make ci-image`), runs `scripts/smoke-image.sh` on it against a throwaway Postgres 18 (`make ci-smoke`), then `docker push` sends those exact bytes; a failed smoke test publishes nothing. The script starts it as production does (`node dist/main.js`, NODE_ENV=production, the PWA on, host network) and fails unless `/health/ready` answers 2xx within 60 s with `version` equal to the build's `APP_VERSION` (`BOOT_EXPECT_VERSION`), it runs as uid 1000 with node as PID 1, the boot log says `Applied N Drizzle migration(s)` (so it needs an empty database), `/auth/login` renders in the app shell with `/bundle.css` and `/modules/htmx.min.js` served, and `docker stop` ends it with exit 0 after `SIGTERM: shutting down`. Both directories are Docker volumes owned by uid 1000, as production's chowned mounts; then two more boots prove the Permissions symptoms: a root-owned data volume ends the boot naming the chown, a root-owned models volume leaves `/health/ready` 503 with `storage` down and the chown as its fix. On failure it prints the container's log. A placeholder model file stands in (refused on its checksum, logged as an error), so the boot never downloads 940 MB; the queue waits for a model, as in production when one cannot be had. It adds about a minute to a publish. Run it locally with `make ci-image ci-smoke CI_BUILD_VERSION=<v>`: a throwaway Postgres 18 (`devkit/bin/throwaway_pg.sh`), torn down after.
- **Nightly (`nightly.yml`)**: the page audit (against `docs/perf/baseline.json`) and Lighthouse, and `real cutout model`: the BiRefNet model cached by `actions/cache` under its pinned checksum (fetched or re-verified by the image's own `npm run cutout:fetch-model`), `scripts/smoke-image.sh` with `MODELS_DIR` (the image cuts out one uploaded photo with its own onnxruntime-node and sharp: what a dependency bump or a Dockerfile change breaks and the per-merge smoke test never loads), then `test/integration/cutout-model.spec.ts` with `CUTOUT_MODEL_REQUIRED=1` (a missing model fails it rather than skipping it), and `webkit`: the whole Playwright suite in the `webkit` and `Mobile Safari` projects (#179; the owner's iPhone is WebKit, the main check Chromium only), one job per project with the PWA on, one retry; its `webkit tracking issue` job (the only one with `issues: write`) opens or updates the one issue titled "Nightly WebKit / Mobile Safari run is failing" with the failing specs and the run's link, and closes it on a green run (`scripts/webkit-nightly-issue.sh`; running WebKit locally and what its skips mean: `docs/testing-webkit.md`). About 15 minutes a project, run side by side. Nothing nightly gates a deploy: a red run is a signal to fix the next merge.
