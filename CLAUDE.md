# Closet

Self-hosted digital wardrobe for the household: catalog garments (photo with background removal, category, brand, size, color), compose outfits, plan them on a calendar, and share a wardrobe with another user. Fork of Libre Closet (Lazztech, AGPL-3.0; repo `agandhi4/closet`, upstream remote `lazztech/libre-closet`). Deployed on the homelab as `closet.box`.

**The primary interface is the installed PWA on phones.** Every feature must work as an installed, offline-tolerant app first and as a desktop web page second.

## Stack

Conventions: `backend.md`, `frontend.md`, `frontend-pwa.md`, `frontend-htmx.md` (hypermedia principles only; the Jinja2/FastAPI specifics do not apply)

- **Runtime**: Node 22 (`.nvmrc` pins `v22.20.0`), TypeScript, NestJS 11 on the **Fastify** adapter (not Express: use `FastifyReply`, `reply.view`, `reply.setCookie`).
- **Views**: server-rendered Handlebars (`@fastify/view`) with htmx 2 for interactivity and `_hyperscript` for client logic. Not a SPA. There is no JSON API for the UI.
- **CSS**: Tailwind v4 (`@tailwindcss/cli`) + daisyUI. Source `views/assets/main.css`, compiled to `public/bundle.css` by `npm run generate:tailwind`.
- **Data**: MikroORM 6 on PostgreSQL only (17 in production on pgvault, 17 in CI, pgvault-dev locally). SQLite was dropped on 2026-09-25: its test tier passed on behavior production never had (case-insensitive `LIKE`, unbounded `varchar`, a drifted `color` type) and its migration tree wiped rows. One migration tree, `src/dal/migrations/postgres/`.
- **Auth**: optional (`AUTH_ENABLED`) JWT in an `access_token` httpOnly cookie, bcrypt passwords. The session is resolved once per request by `AuthContextService` (cookie, JWT, user row, password fingerprint) into `req.auth`; guards only read it: `ConditionalAuthGuard` (open or authenticated, redirect when a session is required and missing), `RequireSessionGuard` (user-only pages: 404 with auth off, redirect without a session), `AuthGuard` (fetch endpoints: 401). Wardrobe permissions come from one `WardrobeShareService.resolveAccess`. `DISABLE_REGISTRATION` locks signup.
- **PWA**: Workbox `injectManifest` over a hand-written service worker (`views/assets/src-sw.ts`, esbuild to `.js`, injected to `public/sw.js`), `/manifest.json` served from config by `AppController`, `@khmyznikov/pwa-install`, `pulltorefreshjs`, Web Push via `web-push` + VAPID keys. Gated by `PWA_ENABLED`.
- **Images**: `sharp` for transcoding, `@imgly/background-removal` in the browser (patched, see gotchas), `heic-convert` for HEIC uploads. See Architecture, Images.
- **Storage**: `src/file/` abstraction, `local` (disk under `DATA_PATH`) or `object` (S3 via `nestjs-s3`).
- **i18n**: `nestjs-i18n`, strings in `src/i18n/<lang>/lang.json`, six languages.
- **Logging**: `nestjs-pino`, pretty to stdout and rotating `app.log` under `DATA_PATH`.
- **Tests**: three tiers. Jest unit (`src/**/*.spec.ts`, mocks everything, verifies wiring); Jest integration (`test/integration/`, the real app in-process on a scratch Postgres database per spec file, driven through `app.inject()`, verifies behavior: HTML, headers, rows, files); Playwright e2e (`test/*.spec.ts`, real browser against a built server). Plus autocannon load test (`scripts/load-test.ts`) and Lighthouse CI.

## Architecture

```
src/
  app.ts               createApp(): Fastify adapter, static assets, view engine + Handlebars helpers,
                       preHandler that resolves the session once (req.auth via AuthContextService) and
                       fills reply.locals; skipped entirely for the static paths in static-prefixes.ts.
                       Shared by main.ts (listen) and the integration harness (init + inject)
  main.ts              createApp() + listen
  project-root.ts      PROJECT_ROOT for public/, views/, node_modules/ paths; valid from src/ and dist/
  app.module.ts        Root module. Joi env schema (the ONLY place config is declared), pino, throttler,
                       i18n, global error-view filter. Every new env var is added here with a default.
  auth/                Login/register/password-reset controllers, JWT service, guards
  dal/                 Data access layer
    dal.module.ts      MikroORM config (Postgres, migrations run on boot)
    entity/            user, garment, outfit, outfit-garment (explicit pivot so its foreign keys carry declared indexes),
                       outfit-calendar, file, passwordReset, shareableId, userDevice, wardrobe-share
    migrations/        postgres/ — the one migration tree
  wardrobe/            Core domain: garments, outfits, calendar. Controllers render views;
                       services own business logic; view-models/ shape entities for templates
  wardrobe-share/      Invite-link sharing (view/edit) between users
  file/                FileService abstract (variants, thumbs, versions, deleteVariants) over local-file/ and
                       s3-file/ backends (get/store/delete/list only); image-variant.ts names variants,
                       file-url/image-url.ts is the one URL builder; heic.ts decodes HEIC uploads before sharp
  maintenance/         StorageReconciliationService: nightly @Cron (MAINTENANCE_ENABLED) and
                       reconcile.cli.ts (`npm run maintenance:reconcile`) keeping storage and the
                       file table in step; owns ScheduleModule.forRoot()
  email/               nodemailer (gmail or mailgun) for password reset
  notification/        Web Push to registered user devices
  open-graph/          OG meta for shared links
  view-context/        Builds the per-request template context (user, flags, i18n) exposed as reply.locals
  i18n/                lang.json per language
views/                 Handlebars, one directory per feature module + partials/ + layout
  assets/              main.css (Tailwind source), src-sw.ts (service worker source)
public/                Static: sw.js (generated), bundle.css (generated), js/, assets/ (icon.svg is the
                       source; icon.png and favicon.ico come from `npm run generate:icons`)
test/                  Playwright specs (smoke.spec.ts is the CI gate)
  integration/         Jest in-process specs + harness.ts (createTestApp, multipart, HTML helpers)
docs/DESIGN.md         Upstream MVP design doc and entity model. Assess feature work against it.
```

### Routes

`GET /` redirects to `/wardrobe`; there is no landing page, and no privacy, terms or sitemap routes. `/about` carries the upstream attribution. `manifest.json` is not a static file: `AppController` serves it from config so `APP_NAME` and `ICON_NAME` flow into the installed PWA's name and icon.

### Request flow

Controller method → `@Render('feature/view')` or `reply.view(...)` → Handlebars template with `layout` → htmx in the browser swaps fragments returned by further controller routes. A route that serves both a page and a fragment decides with `isFragmentRequest` from `src/htmx/fragment-request.ts` (shared with the service worker's cache keys) and sets `Vary: HX-Request`.

### Images

Every photo is a set of WebP files sharing one base name: `<uuid>.webp` (original, 1080px, q90), `<uuid>-nobg.webp` (browser-made cutout, same size), `<uuid>-thumb.webp` (400px, q80, derived from the cutout when present). Only the original has a `File` row; `File.version` is bumped whenever bytes under an existing name are rewritten (a mask edit), and every variant URL carries `?v=<version>` so `FileController` can serve all three immutable for a year. Templates never build `/file/...` by hand: `{{imageUrl photo 'thumb'}}` (grids and strips, with `loading="lazy"` and dimensions) or `'nobg'` (detail, share, Open Graph). Thumbs missing in storage are generated on first request, single-flighted, which backfills old photos. Deletion always goes through `deleteVariants`.

### Config

`ConfigModule` loads `.env.local` then `.env`. `.env` is committed and holds public defaults; `.env.local` is gitignored and is for local development only. **The Docker image bakes `.env` and never sees `.env.local`**, so production configuration is real container environment variables, nothing else.

### PWA and the service worker

`public/sw.js` is a build artifact. Edit `views/assets/src-sw.ts` and run `npm run generate:sw`. The precache manifest comes from `workbox-config.js` globs. Service workers and Web Push require a secure context, which is why production is served over HTTPS (see Deployment).

Delivery model (audit fixes, see `src-sw.ts`, `public/js/pwa.js`, `public/js/connectivity.js`):

- **Static cache key.** Every first-party static URL carries `?v={{appVersion}}` (layout.hbs, the importmap, show.hbs). `appVersion` is `src/build-info.ts`: package.json version plus the commit (or build time) from `public/build.json`, which `scripts/write-build-info.ts` writes during `npm run build`. `app.ts` serves `/modules`, `/js`, `/assets`, `/bg-removal-models` and `bundle.css` as `public, max-age=31536000, immutable`, so **the key is the only thing that rolls the cache**: `npm version`, a new commit in a built tree, or `GIT_SHA` passed to the Docker build all change it; a build with none of those still gets a unique timestamp. `sw.js` and `manifest.json` stay `no-cache`. `NODE_ENV=development` turns the immutable policy off so `tailwind --watch` output shows on a plain reload.
- **Service worker strategies.** public/ files are precached by content hash (`?v` ignored on match). Navigations and htmx requests are NetworkFirst (3 s timeout, `pages-v1`); fragments are keyed `url|hx` by `src/htmx/fragment-request.ts`, which the server uses for the same decision. Versioned scripts are StaleWhileRevalidate (`assets-v1`), `/file/**` images CacheFirst (`images-v1`, 500 entries, 30 days). The background-removal runtime and models revalidate with `cache: 'no-cache'` because the library loads chunks by unversioned URLs. Unmatched requests (POST, `/healthz`) bypass the worker.
- **Updates.** The worker does not `skipWaiting()` on install. `pwa.js` shows an "Update available: Reload" toast on `waiting`, posts `SKIP_WAITING` on tap, and reloads on `controlling`. Never force a reload.
- **Connectivity.** `connectivity.js` probes `GET /healthz` (204, `no-store`, skips the session hook) every 30 s while visible, on every `htmx:sendError`/`responseError`, and every 5 s while offline; it drives `#connectivity-banner` in `partials/app_status.hbs`. `navigator.onLine` is only a hint.
- **Page-only libraries** (sortablejs on the outfit form, `@imgly/background-removal` on the garment page) load from the page that needs them, as ES modules through the importmap in layout.hbs so boosted navigations cannot race a global. Background removal downloads nothing until the photo input or camera button is touched.
- **Wardrobe fragment.** `GET /wardrobe` with a fragment request (`HX-Request` without `HX-Boosted`/history restore) returns `partials/wardrobe_main` with `Vary`; the filter bar and search form target `#wardrobe-main` with `hx-push-url`, so filtering never re-renders navbar and dock.

## Conventions

Upstream rules we keep (from `.github/prompts/boilerplate.prompt.md`), plus ours:

- **Server owns the HTML.** Reach for htmx swaps and `_hyperscript` before any hand-written JS. Client JS extracted to `public/js/` needs a reason stated in the PR.
- **Locality of behavior.** Keep view logic beside its markup. Extract only when reused.
- **Every user-facing string goes through i18n.** `{{t 'lang.KEY'}}` in templates, `i18n.t()` in controllers and DTO validation messages. Add the key to every language file, English first.
- **daisyUI components, not bespoke CSS.** Theme through daisyUI tokens. No hardcoded colors in templates.
- **No runtime CDN imports.** Every client dependency is an npm package served by `useStaticAssets` in `app.ts`. The installed PWA must boot with zero external requests.
- **Config via `ConfigService`**, never `process.env` outside `app.ts`. New env vars: Joi entry in `app.module.ts` with a default, row in the README configuration table.
- **One database: Postgres.** Every tier (integration, Playwright, load test, CI) runs on Postgres. Do not reintroduce a second driver for test speed: the scratch-database harness is as fast as in-memory SQLite was.
- **Cookies stay `Secure`-less.** The `.box` name is HTTP by design (Tailscale encrypts). Adding `secure: true` to `reply.setCookie` in `src/auth/` makes login silently never stick over `http://closet.box`. If a secure cookie is ever wanted it must be driven by a `COOKIE_SECURE` env var defaulting to false.
- **Offline-first UX per `frontend-pwa.md`.** Reads render from cache with a freshness indicator, writes that cannot reach the server are disabled with an explanation, never silently dropped. Connectivity detection is active (heartbeat), not `navigator.onLine`.
- **Logging**: use the injected pino logger with the module name as context. Log at operation boundaries with garment/outfit IDs and user IDs. Nothing inside template rendering or loops.

## Commands

```bash
nvm use                       # Node 22.20.0
npm ci                        # postinstall applies patches/ via patch-package

npm run start:dev             # nest --watch + tailwind --watch
npm run build                 # nest build + generate (tailwind, service worker)
npm run start:prod            # node dist/main
npm run maintenance:reconcile [-- --dry-run]
                              # one storage reconciliation pass from dist/ (build first). On the NAS:
                              # docker exec closet npm run maintenance:reconcile

npm run lint                  # eslint --fix
npm run format                # prettier

# Test tiers, cheapest first
npm test                      # jest unit: mocked DB/fs, verifies wiring. Seconds.
(cd ../pgvault-dev && docker compose up -d --wait)
                              # every tier below needs Postgres: pgvault-dev on localhost:5432 (superuser
                              # postgres, trust auth). Dev app config lives in .env.local (DATABASE_*,
                              # closet_db); see README Development.
npm run test:int              # jest integration: real app in-process, temp DATA_PATH, app.inject().
                              # Asserts HTML, headers, DB rows, files. ~5 s. No build needed.
                              # The default place for behavior assertions during development.
                              # Each spec file gets a scratch database (test/support/scratch-database.ts)
                              # on TEST_DATABASE_URL, default pgvault-dev; CI points it at a postgres:17 service.
npm run test:e2e              # playwright (full): builds + boots :3000 unless one is already running.
npm run test:e2e:smoke        # playwright smoke, the CI gate
                              # test/pwa.spec.ts (service worker, offline shell, lazy model) and
                              # test/auth.spec.ts skip unless the server was started with
                              # PWA_ENABLED=true (+ VAPID keys) / AUTH_ENABLED=true respectively
npm run test:load             # builds, boots on a scratch database + temp DATA_PATH, autocannon
npm run lighthouse            # lhci autorun

npm run precommit             # format:check + lint + test + test:int + build (~16 s, run before every commit)
npm run precommit:full        # + test:cov, e2e smoke, load test, lighthouse (minutes, the pre-PR gate)

# Migrations: diff entities against the committed .snapshot-postgres.json; connects to closet_db on
# pgvault-dev unless DATABASE_* say otherwise
npx mikro-orm migration:create --config mikro-orm.postgres.cli-config.ts

docker build -f docker/Dockerfile -t closet .
```

Builds, test suites, and `npm ci` go through a `build-runner` subagent, never inline.

## Deployment

Runs as the `closet` stack on the homelab NAS (`agandhi4/homelab`, `/volume1/docker/homelab` on the NAS). Same shape as `orbit` and `finplat`: one container from a GHCR image, joined to `homeinfra_web`, fronted by the shared Caddy.

| Piece | Value |
|-------|-------|
| URL (canonical, PWA) | `https://closet.kashhq.dedyn.io` |
| URL (HTTP twin) | `http://closet.box` (no service worker or push here; secure context required) |
| Image | `ghcr.io/agandhi4/closet:latest`, amd64, published by `docker-publish.yml` on every push to `main` |
| Container port | 3000 (`PORT`) |
| Database | pgvault Postgres, `closet_db` / `closet_user`, provisioned by `stacks/homeinfra/scripts/add-app.sh closet --port 3000` |
| Persistent volume | `DATA_PATH` → `/volume1/docker/appdata/closet` (uploaded photos, `app.log`) |
| Caddy | `stacks/homeinfra/caddy/apps.d/closet.caddy` with both `http://closet.box` and `http://closet.kashhq.dedyn.io` → `closet:3000` |
| DNS | nothing: Pi-hole wildcard `address=/box/` covers `closet.box`; `kashhq.dedyn.io` mirrors `.box` |
| DSM reverse proxy | rule for `closet.box` and `closet.kashhq.dedyn.io` → `localhost:8080`, WebSocket header on |
| Auto-update | `closet   # autoupdate` in `hosts/synology/manifest` |

Production env (`hosts/synology/closet.env`, gitignored, values never in this repo):

```
APP_NAME=Closet
SITE_URL=https://closet.kashhq.dedyn.io
PWA_ENABLED=true
AUTH_ENABLED=true
DISABLE_REGISTRATION=true          # flip to false only while creating the two household accounts
ACCESS_TOKEN_SECRET=<openssl rand -hex 32>
TRUSTED_PROXIES=172.16.0.0/12      # Docker bridge range: Caddy is the client Fastify sees, so trust its X-Forwarded-For
PUBLIC_VAPID_KEY=<npx web-push generate-vapid-keys>   # no defaults; required when PWA_ENABLED=true
PRIVATE_VAPID_KEY=<same>
# ICON_NAME left unset (default icon.png)
# WATERMARK_ENABLED left unset (default false)
DATABASE_HOST=pgvault
DATABASE_PORT=5432
DATABASE_SCHEMA=closet_db
DATABASE_USER=closet_user
DATABASE_PASS=<from add-app.sh, hex>
FILE_STORAGE_TYPE=local
DATA_PATH=/app/data
```

Deploy: on the NAS, `cd /volume1/docker/homelab && /usr/local/bin/git pull && ./deploy.sh up synology closet`. Data fixes go through `pgvault-connect closet_db` (read freely, write only when asked, inside a transaction).

## Gotchas

- **`patches/@imgly+background-removal+1.7.0.patch`** is applied on every install. Read it before bumping that package; a version bump silently drops the patch.
- **`@imgly/background-removal-data`** is a tarball from `staticimgly.com`, not the npm registry. Builds need outbound access to that host.
- **`docker-publish.yml` publishes `:latest` on every push to `main`** (and semver tags on `v*` tags from `tag-release.yml`), amd64 only, GHCR only. Merging to main is deploying: the homelab autoupdater redeploys within the hour.
- **Upstream references are limited to attribution.** The only permitted mentions of the upstream project are the attribution link in the About page and README and code comments citing upstream issues or PRs. Any other occurrence of the upstream company or project name (assets, links, config defaults, CI values, marketing copy) is a rebrand regression; grep for it before a PR.
- **Regenerate `package-lock.json` only with Node 22 / npm 10** (`nvm use`, or `docker run --rm -v $PWD:/app -w /app node:22 npm install --package-lock-only`). npm 11 prunes nested entries that npm 10's `npm ci` in the Docker build then reports as missing, so the image build fails while local installs look fine.
- **pgvault-dev runs Postgres 18; production and CI run 17.** Features new in 18 pass locally and fail in CI. The migration CLI's snapshot is pinned to `.snapshot-postgres.json` (`snapshotName`), so pointing it at another database no longer writes a stray `.snapshot-<db>.json`.
- **`precommit:full` is minutes long** (Lighthouse and load test included). Use it as the pre-PR gate; `precommit` is the per-commit one.
- **`test:e2e` rebuilds unless :3000 is busy.** Playwright's `reuseExistingServer` is on outside CI, so leaving `npm run start:prod` running skips the `npm run build` in the webServer command; stop it when you need the e2e run to see fresh code.
- **Integration specs boot one app per file.** `AppModule` reads `process.env` when it is first imported (Joi validation), so `createTestApp` sets the env and then imports `src/app`; a second `createTestApp` with different overrides in the same file would see the first env. Put a different `AUTH_ENABLED` in a different spec file.
- **htmx reads only the first `<meta name="htmx-config">`.** Keep the config in one JSON object. `disableInheritance` is on, so any attribute that must reach descendants needs `hx-inherit` on the ancestor (the body has `hx-inherit="hx-boost"`; without it no link is boosted).
- **`public/build.json` lingers after `npm run build`.** `start:dev` then serves assets with that build's cache key; set `NODE_ENV=development` in `.env.local` (caching off) or delete the file if styles look stale.
- **Nest answers POST with 201 unless the handler has `@HttpCode(200)`**, even when it sends through `@Res()`: htmx partials, `HX-Redirect` replies and re-rendered forms (failed login, validation errors) all come back 201. Integration specs assert 2xx on those; browsers and htmx do not care.
- **Indexes are declared on the entities (`@Index()`), never only in a migration.** Postgres does not index foreign keys on its own, so an FK without an explicit `@Index()` is unindexed. `test/integration/migrations.spec.ts` lists the expected index names.
- **Postgres migrations run one transaction per migration (`allOrNothing: false`)**, in both `dal.module.ts` and `mikro-orm.postgres.cli-config.ts`. Index migrations use `CREATE INDEX CONCURRENTLY IF NOT EXISTS` and override `isTransactional()` to return false; MikroORM runs such migrations on a second connection, which under a batch-wide transaction cannot see tables created earlier in the same batch and fails a fresh database with "relation does not exist". A generated Postgres index migration must be hand-edited to this shape (see `Migration20260925181256`) and `src/dal/migrations/postgres-indexes.spec.ts` enforces it. Never hand-add DDL that the entities do not declare: CLI `migration:up` rewrites `.snapshot-*.json` from the live database, and the next `migration:create` emits a DROP for anything it cannot find in the metadata. SQLite's `migration:create` also needs a migrated `./data/sqlite3.db` (run `migration:up` with the sqlite config first) whenever a column changes type, because knex rebuilds the table from `sqlite_master`; read the generated file, it has duplicated a `create index` line before. To verify a Postgres migration locally: `docker run -d --rm --name pg -p 127.0.0.1:5432:5432 -e POSTGRES_PASSWORD=Password123 postgres:17-alpine`, then `migration:up` / `migration:down` with the postgres CLI config.
- **Photo bytes are written before any row, and rows commit together.** `FileService.storeImageFromFileUpload` / `copyImage` return an unpersisted `File`; the caller (`GarmentService`) persists it inside `em.transactional` with the garment and calls `deleteVariants` if the transaction fails. `GarmentService.remove` and photo replacement delete the `File` row in the same transaction and unlink after commit. Do not `persistAndFlush` a `File` from inside `FileService`.
- **The DB cascade deletes rows, never bytes.** `deleteRule: 'cascade'` on `File.createdBy` and `Garment.owner` drops the rows when a user goes, but only `FileService.deleteVariants` removes the files. Every path that removes a `File` row (`GarmentService.remove`, photo replacement, `AuthService.deleteUser`) must unlink through the file service after commit; the cascade is the safety net and `StorageReconciliationService` (nightly, or `npm run maintenance:reconcile`) is the backstop that deletes photo sets and rows older than a day that nothing references. Outfits and calendar entries own no files.
- **HEIC uploads are buffered.** sharp's libvips has no HEIC decoder, so `image/heic`, `image/heif` and an `application/octet-stream` named `.heic`/`.heif` are read whole (capped by `MAX_HEIC_BYTES`, 413 past it) and decoded with heic-convert to a JPEG before the streaming sharp pipeline. libheif applies the container's rotation while decoding and the JPEG carries no EXIF, so HEIC photos are stored as decoded. Chrome/Android cannot decode HEIC in a canvas: `background-removal.js` skips the client cutout for such files and the form submits the original.
- **`/file/**` serves from DATA_PATH, which also holds `app.log`.** The route accepts only a photo base name as `parseStoredName` defines it (the same rule reconciliation uses); a looser "safe characters" regex served `/file/app.log`, session cookies included, on the public hostname until 2026-09-25. Never add a second definition of a stored name. `test/integration/file-route.spec.ts` covers it.
- **The request logger redacts `cookie`, `authorization` and `set-cookie`, and skips static paths.** The session cookie is a year-long bearer credential and the logs reach `app.log` and Loki. `autoLogging.ignore` must read `originalUrl`: Nest mounts pino-http as middleware, which strips the mount prefix, so `req.url` is `/` for every request.
- **Pipelines started inside a multipart `for await` loop must be armed with a no-op catch at creation.** `GarmentService.storeUploadedPhotoWithCutout` starts the photo and cutout pipelines without awaiting (an unconsumed part hangs busboy) and only settles them after the loop; a rejection while later parts are still being read (an undecodable HEIC/JPEG) was an unhandled rejection that exited the process with an empty reply. `startPipeline()` attaches the catch and returns the same promise, so the real error still surfaces from `Promise.allSettled`. `test/integration/heic.spec.ts` records `unhandledRejection` and asserts the app answers the next request. Node's default (crash loudly) is kept on purpose; do not add a process-level handler.
- **`bufferLogs: true` only flushes on `listen()`.** `createApp()` calls `app.flushLogs()` right after `useLogger`; without it an app that is only `init()`ed (the integration harness) buffers every Nest `Logger` call forever: nothing is emitted, `app.log` stays empty, and a `jest.spyOn(t.app.get(PinoLogger), 'warn')` sees zero calls whatever the app did. `test/integration/heic.spec.ts` asserts on such a spy and would catch a regression.
- **`ScheduleModule.forRoot()` lives in `MaintenanceModule`**, not `AppModule`: `StorageReconciliationService.onApplicationBootstrap` deletes the cron job when `MAINTENANCE_ENABLED=false`, which only works if the scheduler (a deeper module, bootstrapped first) has already registered it. The integration harness sets `MAINTENANCE_ENABLED=false`.
- **Nothing in `precommit` type-checks.** `nest build` uses SWC and `isolatedModules: true` makes ts-jest transpile-only, so `npx tsc --noEmit -p tsconfig.json` reports hundreds of pre-existing errors (spec files lack jest types under the root tsconfig). Run it and grep for the files you touched before calling type-level changes done.

## Workflow

<!-- ORCHESTRATION-OVERRIDE: claudebot agents skip this section.
     Your agent definition governs your workflow. -->

- Before implementing, search Graphiti with `group_ids: ["closet"]` for decisions and gotchas in the area.
- Plan in plain text and get approval before writing code or spawning implementers. Approval of a goal is not approval of an implementation.
- Behavior assertions go in `test/integration/` first: a spec that boots the real app and checks the HTML, headers, rows and files is the default proof that a change works, and it runs in seconds without a build or a browser. Playwright is the full gate for what only a browser can show (service worker, htmx swaps, layout).
- Every feature is still verified in a browser as an installed PWA on a phone-width viewport before it is called done. Type checks and tests verify code, not the app.
- Summarize changes and wait for an explicit go-ahead before committing. After an independent review and verification pass, commit in scoped commits and push straight to `main` (solo repo, no PR); a push to `main` publishes the image and the homelab autoupdater deploys it. Run `npm run precommit` before staging. If a hook fails, fix and create a new commit, never amend.
- Commit messages: concise, why over what.
- When a new pattern or gotcha lands, update this file in the same commit and store the decision in Graphiti.
- Upstream sync: this fork will diverge (rebrand, household features). Keep upstream-worthy fixes in their own commits so they can be offered back to `lazztech/libre-closet`.
