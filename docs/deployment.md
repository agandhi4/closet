# Deployment

Runs as the `closet` stack on **linux-box** (the homelab compute host; `agandhi4/homelab`, deployed checkout `/docker`), moved from the NAS on 2026-09-26 because server-side background removal needs AVX (the NAS's Celeron J4125 has none). Runbook and rollback: the homelab repo's `docs/closet-move-to-linux-box.md`.

| Piece                | Value                                                                                                                                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| URL (canonical, PWA) | `https://closet.example.com` (private: Pi-hole/tailnet split DNS only, no public records)                                                                                                                                                                                                                                  |
| URL (HTTP twin)      | `http://closet.box` (no service worker or push here; secure context required)                                                                                                                                                                                                                                                  |
| Image                | `ghcr.io/agandhi4/closet:latest`, amd64, published by the `publish` job of `ci.yml` after the tests pass, on every non-docs push to `main`                                                                                                                                                                                     |
| Container            | port 3000, `mem_limit 5g` (the model child's native memory is outside Node's heap)                                                                                                                                                                                                                                             |
| Database             | pgvault Postgres on the NAS, `closet_db` / `closet_user`, reached over the LAN at `192.168.1.20:5433`                                                                                                                                                                                                                         |
| Photos               | `DATA_PATH` → the NAS shared folder `closet` (`/volume/closet`), NFS-mounted on linux-box at `/mnt/closet` (fstab automount, same options as Immich's library)                                                                                                                                                                |
| Model                | `MODELS_PATH` → `/srv/docker/closet/models` on linux-box's local disk (BiRefNet 512, downloaded and checksum-verified at first boot)                                                                                                                                                                                           |
| Caddy                | linux-box Caddy: `stacks/caddy/apps.d/closet.caddy` (`http://closet.box`) and the `@closet` block in `kashhq-tls.caddy` (TLS) → `closet:3000` on `linuxbox_web`. After a route change: `docker exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile` (`deploy.sh up` does not restart an unchanged Caddy) |
| DNS                  | Pi-hole map `hosts/pihole/dns/02-box-domain.conf.tmpl`: both names → linux-box; applied by `hosts/pihole/apply.sh`                                                                                                                                                                                                             |
| Auto-update          | `closet    # autoupdate` in `hosts/linux-box/manifest`; the hourly `deploy-update.timer` (:40) on linux-box                                                                                                                                                                                                                    |

Production env (`/docker/hosts/linux-box/closet.env`, mode 600, values never in this repo or printed):

```
SITE_URL=https://closet.example.com          # compose default
DISABLE_REGISTRATION=true          # flip to false only while creating household accounts
ACCESS_TOKEN_SECRET=<openssl rand -hex 32>        # required, 32+ chars; rotated 2026-09-26
PUBLIC_VAPID_KEY=<npx web-push generate-vapid-keys>   # required when PWA_ENABLED=true
PRIVATE_VAPID_KEY=<same>
CLOSET_DB_PASSWORD=<from add-app.sh>
CLOSET_DATA_DIR=/mnt/closet
CLOSET_DB_HOST=192.168.1.20
CLOSET_DB_PORT=5433
CLOSET_WEB_NETWORK=linuxbox_web
TRUSTED_PROXIES=172.23.0.0/16      # linuxbox_web: Caddy is the edge here, so X-Forwarded-For is the real client
CLOSET_MODELS_DIR=/srv/docker/closet/models
METRICS_ENABLED=true               # GET /metrics for vmagent on the Docker network (homelab #39); src/metrics/CLAUDE.md
SENTRY_DSN=http://<key>@bug.box/<project id>   # Bugsink's closet project (#117); unset or empty: error tracking off
ORDER_MAIL_JMAP_TOKEN=<Fastmail API token, Email read-only>   # order email import (#25); unset or empty: off
ORDER_MAIL_SENDERS=<the owner's addresses, comma-separated>
ORDER_MAIL_OWNER=<the owner's closet sign-in email>
# ORDER_MAIL_POLL_MINUTES defaults to 5
# APP_TIMEZONE defaults to America/New_York in the compose file
```

**Error tracking.** `SENTRY_DSN` is the DSN of closet's project in the homelab's Bugsink (`bug.box`, the one finplat reports to; Bugsink shows it on the project's page). The container must reach that name: the boot log says `Error tracking: on (bug.box, release <sha7>)`, and a `Could not send an event to Bugsink` warning (context `ErrorTracking`) means it cannot. Each event's `release` is the image's full git sha: CI's `publish` job passes `GIT_SHA=${{ github.sha }}` as a build-arg, the builder stage's `npm run build` writes it into `public/build.json` (`scripts/write-build-info.ts`), and the image ships that file (`src/build-info.ts` reads it as `BUILD_INFO.sha`). No runtime variable carries it, so the pages' beacon and the server report the same release, the one the `sha-<7>` tag names. A local `npm run build` uses `git rev-parse HEAD`; without `build.json` (`start:dev`, the tests) events have no release. What is captured and how it is scrubbed: `src/metrics/CLAUDE.md`, Error tracking.

**Order email import** (#25; `src/web/wardrobe/order-mail.md`). Off until the token is set. The owner's steps, once:

1. Create a Fastmail account used for nothing else (the order address). Closet only ever reads it.
2. In that account, Settings › Privacy & Security › Manage API tokens › New API token ([Fastmail's help](https://www.fastmail.help/hc/en-us/articles/5254602856719-API-tokens)). Give it **Email** access only, tick **Read-only access**, and leave every other scope (contacts, calendars, sending, masked email) unticked. Copy the token (`fmu1-…`): Fastmail shows it once.
3. Put the token and the owner's addresses in `closet.env` (above): `ORDER_MAIL_SENDERS` lists every address the owner forwards from, and `ORDER_MAIL_OWNER` is the email the owner signs in to closet with. The homelab compose file must pass the three variables through to the container. Redeploy.
4. Forward an order confirmation **by hand** to the order address (an auto-forward rule keeps the retailer as From and is ignored). Within `ORDER_MAIL_POLL_MINUTES` its products show under Wardrobe › ⋯ › From your orders.

The boot log says `Order mail: on (Fastmail, every 5 min, N trusted senders)`; each poll logs one line (context `OrderMail`), and each ignored email says why (`untrusted (sender-not-allowed, from <domain>)`). A failing poll (a revoked token is `JMAP session refused (http-status 401)`) counts as `job_duration_seconds{name="order_mail",outcome="failure"}` and reaches Bugsink; the token never appears in logs or events. To turn it off, unset the token and redeploy; the review list's rows stay. To rotate, create a new token, swap it in, redeploy, then revoke the old one in Fastmail.

**Trusted proxies.** `TRUSTED_PROXIES` must include the address Caddy connects from (Request security). Check with the boot log line `Trusted proxies: ...` and a rate-limit hit's `for <ip>` warning: it must name the client, not Caddy.

**Demo login.** `docker exec closet npm run seed -- --persona demo --share-with <owner email>` seeds Theo (a random password, printed once; registration stays disabled, the CLI inserts the user) and shares his wardrobe with the owner's account. `--reset` (with `--share-with` again) after the bible changes; `--persona demo --remove` takes it out, and `npm run maintenance:reconcile -- --dry-run` then reports nothing. The hourly autoupdate never reseeds. A forgotten password: `user:set-password -- demo@closet.invalid`.

**Locked out.** There is no email reset. On linux-box: `docker exec -it closet npm run user:set-password -- <email>` asks for the new password twice without echoing it (or reads it from piped stdin), applies the registration rules, and signs out every session of that account (its access tokens and push subscriptions revoked with them). An unknown email exits 1 and changes nothing, and so does a database the running build has not migrated yet (it never migrates).

**One container at a time.** `container_name: closet` makes `docker compose up -d` stop and remove the old container before the new one starts, so two builds never serve or write photos together (the new one migrates at boot). **Rolling back past #141** (the variant-key cutouts, `drizzle/0027`) is not free: the older build serves only unkeyed cutout names, and every cutout made or edited since was stored keyed with its unkeyed predecessor deleted, so those photos show their original until cut again; a mask edit the older build saves bumps the version without touching `variant_key`, so the newer build, back again, serves the key's older mask. After such a round trip, `update file set variant_key = null where variant_key is not null and file_name in (...)` for the photos edited meanwhile, then re-cut or re-edit them.

**Rotating the secret.** Set a new `ACCESS_TOKEN_SECRET` (`openssl rand -hex 32`) in `closet.env`, redeploy (`./deploy.sh up linux-box closet`), then `docker exec closet npm run push:revoke-all`: the rotation signed everyone out, and a device left closed would otherwise keep receiving its account's reminders until it next opened the app (the login page drops its browser subscription then). After the restart, not before: a session still open re-sends its subscription on its next page. Everyone signs in again and re-enables notifications and reminders on the profile. Personal access tokens are unaffected (Request security, Session revocation).

Deploy now (instead of waiting for the hourly timer): on linux-box, `docker pull ghcr.io/agandhi4/closet:latest && cd /docker && git pull --ff-only && ./deploy.sh up linux-box closet` (`up` does not pull images). Data fixes go through pgvault (read freely, write only when asked, inside a transaction).

## CI and publishing

- **`ci.yml`'s `publish` job pushes `:latest` and `sha-<7>` only after `check` and `e2e` pass** (and semver tags on `v*` tags from `tag-release.yml`), amd64 only, GHCR only. Until 2026-09-25 publishing was a separate workflow racing CI, so a red run still deployed. Docs-only pushes to main (`docs/**`, `*.md`) skip CI and publish entirely, and run `docs.yml` (`npm run docs:check`) instead, whose `paths` are exactly `ci.yml`'s `paths-ignore`; pull requests always run both jobs, docs-only ones included, because branch protection requires them. Merging to main is deploying: the homelab autoupdater redeploys within the hour. The browser job runs with the PWA on, as production does; specs sign in through `test/support/e2e-session.ts`. Load test and Lighthouse run nightly (`nightly.yml`).
