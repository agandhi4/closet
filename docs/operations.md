# Deployment

Runs as the `closet` stack on **linux-box** (the homelab compute host; `agandhi4/homelab`, deployed checkout `/docker`), moved from the NAS on 2026-09-26 because server-side background removal needs AVX (the NAS's Celeron J4125 has none). Runbook and rollback: the homelab repo's `docs/closet-move-to-linux-box.md`.

| Piece                | Value                                                                                                                                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| URL (canonical, PWA) | `https://closet.kashhq.dedyn.io` (private: Pi-hole/tailnet split DNS only, no public records)                                                                                                                                                                                                                                  |
| URL (HTTP twin)      | `http://closet.box` (no service worker or push here; secure context required)                                                                                                                                                                                                                                                  |
| Image                | `ghcr.io/agandhi4/closet:latest`, amd64, published by the `publish` job of `ci.yml` once it boots (smoke test), on every non-docs push to `main`                                                                                                                                                                               |
| Container            | port 3000, uid 1000 (Permissions), `mem_limit 5g` (the model child's native memory is outside Node's heap)                                                                                                                                                                                                                                             |
| Database             | pgvault Postgres on the NAS, `closet_db` / `closet_user`, reached over the LAN at `192.168.8.173:5433`                                                                                                                                                                                                                         |
| Photos               | `DATA_PATH` → the NAS shared folder `closet` (`/volume1/closet`), NFS-mounted on linux-box at `/mnt/closet` (fstab automount, same options as Immich's library)                                                                                                                                                                |
| Model                | `MODELS_PATH` → `/srv/docker/closet/models` on linux-box's local disk (BiRefNet 512, downloaded and checksum-verified at first boot)                                                                                                                                                                                           |
| Caddy                | linux-box Caddy: `stacks/caddy/apps.d/closet.caddy` (`http://closet.box`) and the `@closet` block in `kashhq-tls.caddy` (TLS) → `closet:3000` on `linuxbox_web`. After a route change: `docker exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile` (`deploy.sh up` does not restart an unchanged Caddy) |
| DNS                  | Pi-hole map `hosts/pihole/dns/02-box-domain.conf.tmpl`: both names → linux-box; applied by `hosts/pihole/apply.sh`                                                                                                                                                                                                             |
| Auto-update          | `closet    # autoupdate` in `hosts/linux-box/manifest`; the hourly `deploy-update.timer` (:40) on linux-box                                                                                                                                                                                                                    |
| Public MCP | `https://closet-mcp.kashhq.com/mcp`: Pangolin VPS (TLS, SSO off) → Newt → the homelab stack `closet-mcp-gate` (Caddy: forwards only `POST /mcp` to closet, 404 otherwise). The personal access token is the only gate |

Production env (`/docker/hosts/linux-box/closet.env`, mode 600, values never in this repo or printed):

```
SITE_URL=https://closet.kashhq.dedyn.io          # compose default
DISABLE_REGISTRATION=true          # flip to false only while creating household accounts
ACCESS_TOKEN_SECRET=<openssl rand -hex 32>        # required, 32+ chars; rotated 2026-09-26
PUBLIC_VAPID_KEY=<npx web-push generate-vapid-keys>   # required when PWA_ENABLED=true
PRIVATE_VAPID_KEY=<same>
CLOSET_DB_PASSWORD=<from add-app.sh>
CLOSET_DATA_DIR=/mnt/closet
CLOSET_DB_HOST=192.168.8.173
CLOSET_DB_PORT=5433
CLOSET_WEB_NETWORK=linuxbox_web
TRUSTED_PROXIES=172.23.0.0/16      # linuxbox_web: Caddy is the edge here, so X-Forwarded-For is the real client
CLOSET_MODELS_DIR=/srv/docker/closet/models
METRICS_ENABLED=true               # GET /metrics for vmagent on the Docker network (homelab #39); src/metrics/AGENTS.md
SENTRY_DSN=http://<key>@bug.box/<project id>   # Bugsink's closet project (#117); unset or empty: error tracking off
ORDER_MAIL_JMAP_TOKEN=<Fastmail API token, Email read-only>   # order email import (#25); unset or empty: off
ORDER_MAIL_SENDERS=<the owner's addresses, comma-separated>
ORDER_MAIL_OWNER=<the owner's closet sign-in email>
# ORDER_MAIL_POLL_MINUTES defaults to 5
# APP_TIMEZONE defaults to America/New_York in the compose file
```

**Error tracking.** `SENTRY_DSN` is the DSN of closet's project in the homelab's Bugsink (`bug.box`, the one finplat reports to; Bugsink shows it on the project's page). The container must reach that name: the boot log says `Error tracking: on (bug.box, release <sha7>, environment production)`, and a `Could not send an event to Bugsink` warning (logger `ErrorTracking`) means it cannot. Each event's `release` is the image's `APP_VERSION`, the bare 7-char sha: CI's `publish` job passes it as a build arg, the Dockerfile's final stage bakes it in as env and as the `org.opencontainers.image.version` label, and `src/build-info.ts` resolves it once at boot (`BuildInfo.release`), so `/health/ready`, the pages' beacon and the server report the same release, the one the image tag `sha-<7>` names with its prefix. Its `environment` is `APP_ENV`: `production` by default, `gate` in the smoke test, `dev` for `npm run start:dev` and the tests. Compose never sets it. A local `npm run build` names its release from `git rev-parse HEAD` (`public/build.json`); without either (`start:dev`, the tests) it is `dev`. What is captured and how it is scrubbed: `src/metrics/AGENTS.md`, Error tracking.

**Order email import** (#25; `src/web/wardrobe/order-mail.md`). Off until the token is set. The owner's steps, once:

1. Create a Fastmail account used for nothing else (the order address). Closet only ever reads it.
2. In that account, Settings › Privacy & Security › Manage API tokens › New API token ([Fastmail's help](https://www.fastmail.help/hc/en-us/articles/5254602856719-API-tokens)). Give it **Email** access only, tick **Read-only access**, and leave every other scope (contacts, calendars, sending, masked email) unticked. Copy the token (`fmu1-…`): Fastmail shows it once.
3. Put the token and the owner's addresses in `closet.env` (above): `ORDER_MAIL_SENDERS` lists every address the owner forwards from, and `ORDER_MAIL_OWNER` is the email the owner signs in to closet with. The homelab compose file must pass the three variables through to the container. Redeploy.
4. Forward an order confirmation **by hand** to the order address (an auto-forward rule keeps the retailer as From and is ignored). Within `ORDER_MAIL_POLL_MINUTES` its products show under Wardrobe › ⋯ › From your orders.

The boot log says `Order mail: on (Fastmail, every 5 min, N trusted senders)`; each poll logs one line (logger `OrderMail`), and each ignored email says why (`untrusted (sender-not-allowed, from <domain>)`). A failing poll (a revoked token is `JMAP session refused (http-status 401)`) counts as `job_duration_seconds{name="order_mail",outcome="failure"}` and reaches Bugsink; the token never appears in logs or events. To turn it off, unset the token and redeploy; the review list's rows stay. To rotate, create a new token, swap it in, redeploy, then revoke the old one in Fastmail.

**Trusted proxies.** `TRUSTED_PROXIES` must include the address Caddy connects from (Request security). Check with the boot log line `Trusted proxies: ...` and a rate-limit hit's `for <ip>` warning: it must name the client, not Caddy.

**Demo login.** `docker exec closet npm run seed -- --persona demo --share-with <owner email>` seeds Theo (a random password, printed once; registration stays disabled, the CLI inserts the user) and shares his wardrobe with the owner's account. `--reset` (with `--share-with` again) after the bible changes; `--persona demo --remove` takes it out, and `npm run maintenance:reconcile -- --dry-run` then reports nothing. The hourly autoupdate never reseeds. A forgotten password: `user:set-password -- demo@closet.invalid`.

**Locked out.** There is no email reset. On linux-box: `docker exec -it closet npm run user:set-password -- <email>` asks for the new password twice without echoing it (or reads it from piped stdin), applies the registration rules, and signs out every session of that account (its access tokens and push subscriptions revoked with them). An unknown email exits 1 and changes nothing, and so does a database the running build has not migrated yet (it never migrates).

**One container at a time.** `container_name: closet` makes `docker compose up -d` stop and remove the old container before the new one starts, so two builds never serve or write photos together (the new one migrates at boot). **Rolling back past #141** (the variant-key cutouts, `drizzle/0027`) is not free: the older build serves only unkeyed cutout names, and every cutout made or edited since was stored keyed with its unkeyed predecessor deleted, so those photos show their original until cut again; a mask edit the older build saves bumps the version without touching `variant_key`, so the newer build, back again, serves the key's older mask. After such a round trip, `update file set variant_key = null where variant_key is not null and file_name in (...)` for the photos edited meanwhile, then re-cut or re-edit them.

**Rotating the secret.** Set a new `ACCESS_TOKEN_SECRET` (`openssl rand -hex 32`) in `closet.env`, redeploy (`./deploy.sh up linux-box closet`), then `docker exec closet npm run push:revoke-all`: the rotation signed everyone out, and a device left closed would otherwise keep receiving its account's reminders until it next opened the app (the login page drops its browser subscription then). After the restart, not before: a session still open re-sends its subscription on its next page. Everyone signs in again and re-enables notifications and reminders on the profile. Personal access tokens are unaffected (Request security, Session revocation).

Deploy now (instead of waiting for the hourly timer): on linux-box, `docker pull ghcr.io/agandhi4/closet:latest && cd /docker && git pull --ff-only && ./deploy.sh up linux-box closet` (`up` does not pull images). Data fixes go through pgvault (read freely, write only when asked, inside a transaction).

## Permissions

The image runs as `node`, **uid/gid 1000** (the Dockerfile's `USER`), never root. It writes exactly two directories, both host mounts in production, and a mount keeps the host's ownership, so both must be writable by uid 1000 on the host:

| In the container | linux-box (`closet.env`) | Compose default (the NAS layout) | What writes it |
| --- | --- | --- | --- |
| `/app/data` (`DATA_PATH`) | `/mnt/closet`: NFS from the NAS's `/volume1/closet` | `/volume1/docker/appdata/closet` | photos, `.incoming/`, `app.log` |
| `/app/models` (`MODELS_PATH`) | `/srv/docker/closet/models`, local disk | `/volume1/docker/appdata/closet-models` | the model's download at first boot |

```bash
# linux-box, as root: the models directory (local disk) is root-owned from the root image's download
sudo chown -R 1000:1000 /srv/docker/closet/models
# The NFS share squashes every client user to the NAS admin (DSM NFS rule "Map all users to admin",
# homelab docs/closet-move-to-linux-box.md), so uid 1000 already writes it and a chown there is
# refused or ignored. Prove both as uid 1000 with the image itself:
docker run --rm --user 1000:1000 -v /mnt/closet:/d -v /srv/docker/closet/models:/m --entrypoint sh \
  ghcr.io/agandhi4/closet:latest -c 'for d in /d /m; do touch $d/.probe && rm $d/.probe || exit 1; done; echo writable'
```

If `/mnt/closet` fails that probe, the DSM rule is not squashing: restore "Map all users to admin", or with "No mapping" run `sudo chown -R 1000:1000 /mnt/closet` from linux-box.

**The symptom** of a directory uid 1000 cannot write: a root-owned `/app/data` ends the boot (the container restarts in a loop) with the fatal line `DATA_PATH /app/data is not writable by this process (EACCES): chown -R 1000:1000 the host directory mounted at /app/data; docs/operations.md#permissions`, before anything else is logged. A root-owned `/app/models` boots and serves pages, but `/health/ready` answers 503 with `storage` down and that chown as its `fix`, the container goes unhealthy and autoheal restarts it, and the model download fails (`Downloading BiRefNet 512x512 failed`, `EACCES`). A directory that stops being writable later (the NFS share remounted read-only) shows the same `storage` check within 5 s. `docker exec closet ...` runs as uid 1000 too (`npm` caches under `/home/node`).

## Health

`GET /health/live` checks nothing (the phones' connectivity heartbeat). `GET /health/ready` (alias `/healthz`) is what the image's `HEALTHCHECK` (every 30 s, 60 s start period), the smoke boot and devkit's contract probe read: 200 `{"status": "up", "version": "<sha7>", "checks": {...}}`, or 503 `"down"` when a required check is down. It is limited to 60 a minute per address. Each down check names this section as its `fix`, and the log line (logger `Health`, `Readiness: ...`) says why:

- **`database`** (required): the pool's one statement did not answer in 3 s or failed. Check pgvault on the NAS and `CLOSET_DB_HOST`; the app recovers by itself once it answers.
- **`migrations`** (required): the database's newest Drizzle migration is older than this build's, so it was restored or repointed after the boot. Restart the container: the boot migrates.
- **`storage`** (required): a directory the process writes (`DATA_PATH`, `MODELS_PATH`) refused a create and unlink as uid 1000; its `fix` is the chown and the log line names the directory and the error code. Probed at most once every 5 s: see Permissions.
- **`cron_jobs`** (optional): a timer's run has been in flight over 30 minutes (`stuck` names it). Its last `cron-` lines in Loki say where it hangs; a restart starts it afresh.
- **`cutout_queue`** (optional): the background-removal queue is not running. In production that means the process is shutting down.

Optional checks never make the app down: every page still serves while one is down, and a restart loop would cost the household the app. Compose inherits the image's `HEALTHCHECK`; homelab's closet stack has no `autoheal: "true"` label yet, so until it does an unhealthy container is only marked, never restarted.

## CI and publishing

- **PRs are gated locally, not in Actions** (2026-09-28, Actions limits; in-repo since 2026-10-13): `make gate PR=<n>` (`devkit/bin/local_gate.sh` with `scripts/ci/gate_plan.sh`) runs the Makefile's `ci-quick`, `ci-db`, `ci-e2e` and `ci-image` jobs the diff can affect on the PR merged into `main`, each on its own throwaway Postgres 18 container, and posts the one `local-gate` status branch protection requires beside `codex-review`. The browser job runs with the PWA on, as production does; specs sign in through `test/support/e2e-session.ts`. `ci.yml`'s manual jobs call the same make targets.
- **On a push to main `ci.yml` runs only `publish`**, which pushes `:latest` and `sha-<7>`, amd64 only, GHCR only, then creates the git tag `ship-<YYYY-MM-DD>-<sha7>` (`devkit/bin/ship_tag.sh`; idempotent, refuses a sha not on `main`): pushing `latest` is the deploy, so that job alone moves it and runs never cancel. Semver releases (`tag-release.yml`, `release/X.Y.Z` branches) and date tags are retired (2026-10-13). Until 2026-09-25 publishing was a separate workflow racing CI, so a red run still deployed. Docs-only pushes to main (`docs/**`, `*.md`) skip it entirely: `make docs-check` already passed on the PR (the gate's `quick` job, on the head and `main` the merge queue merges), so nothing re-runs it on main. Merging to main is deploying: the homelab autoupdater redeploys within the hour.
- **The image is booted before it is pushed** (#181). `publish` builds it once into the runner's Docker (`load: true`, the gha layer cache), runs `scripts/smoke-image.sh` against a Postgres 18 service, then `docker push --all-tags` sends those exact bytes; a failed smoke test publishes nothing. The script starts it as production does (`node dist/main.js`, NODE_ENV=production, the PWA on, host network) and fails unless `/health/ready` answers 2xx within 60 s with `version` equal to the build's `APP_VERSION` (`BOOT_EXPECT_VERSION`), it runs as uid 1000 with node as PID 1, the boot log says `Applied N Drizzle migration(s)` (so it needs an empty database), `/auth/login` renders in the app shell with `/bundle.css` and `/modules/htmx.min.js` served, and `docker stop` ends it with exit 0 after `SIGTERM: shutting down`. Both directories are Docker volumes owned by uid 1000, as production's chowned mounts; then two more boots prove the Permissions symptoms: a root-owned data volume ends the boot naming the chown, a root-owned models volume leaves `/health/ready` 503 with `storage` down and the chown as its fix. On failure it prints the container's log. A placeholder model file stands in (refused on its checksum, logged as an error), so the boot never downloads 940 MB; the queue waits for a model, as in production when one cannot be had. It adds about a minute to the job. Run it locally with `make ci-image ci-smoke CI_BUILD_VERSION=<v>`: a throwaway Postgres 18 (`devkit/bin/throwaway_pg.sh`), torn down after.
- **Nightly (`nightly.yml`)**: the page audit (against `docs/perf/baseline.json`) and Lighthouse, and `real cutout model`: the BiRefNet model cached by `actions/cache` under its pinned checksum (fetched or re-verified by the image's own `npm run cutout:fetch-model`), `scripts/smoke-image.sh` with `MODELS_DIR` (the image cuts out one uploaded photo with its own onnxruntime-node and sharp: what a dependency bump or a Dockerfile change breaks and the per-merge smoke test never loads), then `test/integration/cutout-model.spec.ts` with `CUTOUT_MODEL_REQUIRED=1` (a missing model fails it rather than skipping it), and `webkit`: the whole Playwright suite in the `webkit` and `Mobile Safari` projects (#179; the owner's iPhone is WebKit, the PR gate Chromium only), one job per project with the PWA on, one retry; its `webkit tracking issue` job (the only one with `issues: write`) opens or updates the one issue titled "Nightly WebKit / Mobile Safari run is failing" with the failing specs and the run's link, and closes it on a green run (`scripts/webkit-nightly-issue.sh`; running WebKit locally and what its skips mean: `docs/testing-webkit.md`). About 15 minutes a project, run side by side. Nothing nightly gates a deploy: a red run is a signal to fix the next merge.
