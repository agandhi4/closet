# Closet

Self-hosted digital wardrobe for the household: catalog garments (photo with background removal, category, brand, size, color), compose outfits, plan them on a calendar, and share a wardrobe with another user. Fork of Libre Closet (Lazztech, AGPL-3.0; repo `agandhi4/closet`, upstream remote `lazztech/libre-closet`). Deployed on the homelab as `closet.box`.

**The primary interface is the installed PWA on phones.** Every feature must work as an installed, offline-tolerant app first and as a desktop web page second.

## Stack

Conventions: `backend.md`, `frontend.md`, `frontend-pwa.md`, `frontend-htmx.md` (hypermedia principles only; the Jinja2/FastAPI specifics do not apply)

- **Runtime**: Node 22 (`.nvmrc` pins `v22.20.0`), TypeScript, NestJS 11 on the **Fastify** adapter (not Express: use `FastifyReply`, `reply.view`, `reply.setCookie`).
- **Views**: server-rendered Handlebars (`@fastify/view`) with htmx 2 for interactivity and `_hyperscript` for client logic. Not a SPA. There is no JSON API for the UI.
- **CSS**: Tailwind v4 (`@tailwindcss/cli`) + daisyUI. Source `views/assets/main.css`, compiled to `public/bundle.css` by `npm run generate:tailwind`.
- **Data**: PostgreSQL only (17 in production on pgvault, 17 in CI, pgvault-dev locally). **Drizzle ORM owns the schema and the migrations** (`src/db/schema.ts`, `drizzle/`, applied at boot by `src/db/migrate.ts`; see Changing the schema) since 2026-09-25. Queries still go through MikroORM 6 entities (`src/dal/entity/`) until each feature is ported to Drizzle; ported code injects the Drizzle instance (`@Inject(DB) db: Db`). The MikroORM migration tree `src/dal/migrations/postgres/` is frozen history that nothing runs at runtime. SQLite was dropped on 2026-09-25: its test tier passed on behavior production never had (case-insensitive `LIKE`, unbounded `varchar`, a drifted `color` type) and its migration tree wiped rows.
- **Auth**: login is always required (the upstream `AUTH_ENABLED=false` mode was removed 2026-09-25). JWT in an `access_token` httpOnly cookie, bcrypt passwords. The session is resolved once per request by `AuthContextService` (cookie, JWT, user row, password fingerprint) into `req.auth`. One global `SessionGuard` (APP_GUARD, after the throttler) only reads it: every route needs a session unless it is `@Public()`; without one a page navigation is a 302 to `/auth/login` and an htmx fragment or fetch a 401 with `HX-Redirect: /auth/login`. Handlers take the user as `@UserId() userId: number`. There is no password reset by email (removed with `src/email/` on 2026-09-25); a signed-in user changes it at `/auth/change-password`, which needs the current password, revokes every other session through the fingerprint and reissues this one's cookie. A forgotten password is a data fix through `pgvault-connect closet_db`. Wardrobe permissions come from one `WardrobeShareService.resolveAccess`. `DISABLE_REGISTRATION` locks signup.
- **PWA**: Workbox `injectManifest` over a hand-written service worker (`views/assets/src-sw.ts`, esbuild to `.js`, injected to `public/sw.js`), `/manifest.json` served from config by `AppController`, `@khmyznikov/pwa-install`, `pulltorefreshjs`, Web Push via `web-push` + VAPID keys. Gated by `PWA_ENABLED`.
- **Images**: `sharp` for transcoding, `@imgly/background-removal` in the browser (patched, see gotchas), `heic-convert` for HEIC uploads. See Architecture, Images.
- **Storage**: `src/file/` abstraction, `local` (disk under `DATA_PATH`) or `object` (S3 via `nestjs-s3`).
- **i18n**: `nestjs-i18n`, strings in `src/i18n/<lang>/lang.json`, six languages.
- **Logging**: `nestjs-pino`, pretty to stdout and rotating `app.log` under `DATA_PATH`.
- **Tests**: three tiers. Vitest unit (`src/**/*.spec.ts`, mocks everything, verifies wiring); Vitest integration (`test/integration/`, the real app in-process on a scratch Postgres database per spec file, driven through `app.inject()`, verifies behavior: HTML, headers, rows, files); Playwright e2e (`test/*.spec.ts`, real browser against a built server). Both Vitest tiers are projects of one `vitest.config.ts` (unplugin-swc for Nest's decorator metadata; specs import `describe`/`it`/`expect`/`vi` from `'vitest'`, no globals). Integration specs assert rows through `t.db` (Drizzle); `t.em()` (MikroORM) stays for the existing specs. Plus autocannon load test (`scripts/load-test.ts`) and Lighthouse CI. Vitest replaced Jest on 2026-09-25, the first step of a platform migration (NestJS to plain Fastify and MikroORM to Drizzle follow feature by feature).

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
  auth/                Login/register/account controllers (profile, update email, change password,
                       delete account), AuthService, AuthContextService (session),
                       SessionGuard + @Public() (the one auth gate), @UserId(), RegistrationGuard
  db/                  Drizzle: the schema and migration authority, and the query layer ported code uses
    schema.ts          Every table, index, constraint and relation (the source of drizzle/ migrations)
    client.ts          createDb(config): one pg Pool (max 5, min 2) + drizzle(); framework-free
    migrate.ts         runMigrations(config): boot-time runner (legacy adoption, advisory lock)
    db.module.ts       Global Nest module: DB token, runs the migrations onModuleInit, closes the pool
  dal/                 MikroORM, for queries not yet ported
    dal.module.ts      MikroORM config (no migrator)
    entity/            user, garment, outfit, outfit-garment (explicit pivot), outfit-calendar, file,
                       shareableId, userDevice, wardrobe-share. Kept in step with src/db/schema.ts by hand
    migrations/        postgres/ — the frozen MikroORM tree; only test/support/legacy-migrations.ts runs it
  wardrobe/            Core domain: garments, outfits, calendar. Controllers render views;
                       services own business logic; view-models/ shape entities for templates
  wardrobe-share/      Invite-link sharing (view/edit) between users
  file/                FileService abstract (variants, thumbs, versions, deleteVariants) over local-file/ and
                       s3-file/ backends (get/store/delete/list only); image-variant.ts names variants,
                       file-url/image-url.ts is the one URL builder; heic.ts decodes HEIC uploads before sharp
  maintenance/         StorageReconciliationService: nightly @Cron (MAINTENANCE_ENABLED) and
                       reconcile.cli.ts (`npm run maintenance:reconcile`) keeping storage and the
                       file table in step; owns ScheduleModule.forRoot()
  notification/        Web Push to registered user devices
  open-graph/          OG meta for shared links
  view-context/        Builds the per-request template context (user, flags, i18n) exposed as reply.locals
  i18n/                lang.json per language
views/                 Handlebars, one directory per feature module + partials/ + layout
  assets/              main.css (Tailwind source), src-sw.ts (service worker source)
public/                Static: sw.js (generated), bundle.css (generated), js/, assets/ (icon.svg is the
                       source; icon.png and favicon.ico come from `npm run generate:icons`)
test/                  Playwright specs (CI runs all of them in Chromium with the PWA on)
  support/             scratch-database.ts (integration tier + load test), e2e-session.ts (Playwright signIn),
                       schema-drift.ts (drizzle-kit pushSchema), legacy-migrations.ts (builds a MikroORM-era database)
drizzle/               Generated migrations (NNNN_name.sql) + meta/ (journal, snapshots). Shipped in the image
  integration/         Vitest in-process specs + harness.ts (createTestApp, multipart, HTML helpers)
docs/DESIGN.md         Upstream MVP design doc and entity model. Assess feature work against it.
```

### Routes

`GET /` redirects to `/wardrobe`; there is no landing page, and no privacy, terms or sitemap routes. Public (`@Public()`, reachable signed out): login, registration, logout, `/about`, `/offline.html`, `/healthz`, `/manifest.json`, `/.well-known/*`, the Open Graph share page `/share`, the invite landing `/wardrobe-share/invite/:token`, and every `/file/**` image. Everything else needs a session. `/about` carries the upstream attribution. `manifest.json` is not a static file: `AppController` serves it from config so `APP_NAME` and `ICON_NAME` flow into the installed PWA's name and icon.

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
- **No runtime CDN imports.** Every client dependency is an npm package served by the `@fastify/static` registrations in `app.ts` (`registerStaticAssets`). The installed PWA must boot with zero external requests.
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

npm run lint                  # eslint --fix (src, test, scripts); lint:check is the no-fix, cached gate
npm run format                # prettier --write; format:check is the cached gate

# Test tiers, cheapest first
npm test                      # Vitest unit projects (unit, unit-new-york): mocked DB/fs, verifies wiring. ~1.5 s.
npm run test:watch            # the same in watch mode; test:debug waits for an inspector on :9229
(cd ../pgvault-dev && docker compose up -d --wait)
                              # every tier below needs Postgres: pgvault-dev on localhost:5432 (superuser
                              # postgres, trust auth). Dev app config lives in .env.local (DATABASE_*,
                              # closet_db); see README Development.
npm run test:int              # Vitest integration project: real app in-process, temp DATA_PATH, app.inject().
                              # Asserts HTML, headers, DB rows, files. ~5 s. No build needed.
                              # The default place for behavior assertions during development.
                              # Each spec file gets a scratch database (test/support/scratch-database.ts)
                              # on TEST_DATABASE_URL, default pgvault-dev; CI points it at a postgres:17 service.
npm run test:e2e              # build, then playwright (all browsers); serves dist on :3000 unless one is running.
npm run test:e2e:smoke        # build, then the smoke spec in chromium
                              # test/pwa.spec.ts (service worker, offline shell, lazy model) skips
                              # unless the server was started with PWA_ENABLED=true (+ VAPID keys,
                              # https: SITE_URL). Production config locally, as CI's e2e job runs it:
                              # SITE_URL=https://closet.test PWA_ENABLED=true \
                              #   PUBLIC_VAPID_KEY=.. PRIVATE_VAPID_KEY=.. npm run verify:push
npm run test:load             # builds, boots on a scratch database + temp DATA_PATH, autocannon
npm run lighthouse            # lhci autorun

npm run test:all              # every Vitest project in one run (vitest.config.ts); test:cov adds v8 coverage in coverage/
npm run typecheck             # tsc: app + tests + scripts, then the service worker (~3 s cold)
npm run check                 # format:check, lint:check, typecheck and test:all in parallel (~12 s).
                              # The pre-commit hook. `precommit` is an alias.
npm run verify:push           # build + Chromium Playwright against the fresh build. The pre-push hook.
npm run precommit:full        # check + verify:push + load test + lighthouse (minutes)

# Git hooks live in .githooks/ and are installed by `npm install` (the prepare script sets
# core.hooksPath; skipped where there is no .git, e.g. the Docker build). They need pgvault-dev.

# Schema change: edit src/db/schema.ts, then write drizzle/NNNN_<name>.sql + snapshot (no database
# needed). The next boot applies it. See Changing the schema.
npx drizzle-kit generate --name <what-changed>

docker build -f docker/Dockerfile -t closet .
```

Builds, test suites, and `npm ci` go through a `build-runner` subagent, never inline.

## Changing the schema

`src/db/schema.ts` is the schema; `drizzle/` holds the migrations drizzle-kit generates from it. The app migrates on every boot (`DbModule.onModuleInit`: a global module, so before every other module's init and the maintenance cron), so a deploy is the migration.

1. Edit `src/db/schema.ts`. Name new indexes and constraints the way the existing ones are (`<table>_<column>_index`, `_unique`, `_foreign`; MikroORM's names, kept). Every foreign key column gets an explicit `index()`: Postgres does not index them on its own.
2. `npx drizzle-kit generate --name <what-changed>` writes `drizzle/NNNN_<name>.sql` and `meta/NNNN_snapshot.json` from the diff against the last snapshot. Read the SQL: a rename it cannot tell from drop + add makes it prompt (run it in a terminal), and data fixes (backfills, deletes before `SET NOT NULL`) are hand-added to the generated file.
3. If a MikroORM entity in `src/dal/entity/` maps the table, change it to match by hand. Nothing checks the entities against the database any more; a mismatch fails at query time.
4. `npm run test:int`: `test/integration/migrations.spec.ts` asserts that drizzle-kit's `pushSchema` finds nothing to change after boot (a schema edit without its migration fails there, naming the missing statement) and lists the index names queries rely on.
5. Never edit or delete a migration that has shipped. Drizzle applies every file whose journal `when` is newer than the last row in `drizzle.__drizzle_migrations` and never re-checks hashes, so an edited file silently diverges from production.

**Pending migrations run in one transaction, all files together** (drizzle-orm's migrator). A failed batch leaves nothing behind, and `CREATE INDEX CONCURRENTLY` cannot run inside it. The tables are household-sized, so a plain `CREATE INDEX` holds its write lock for milliseconds; if a table ever grows to where that matters, build the index in a non-transactional step added to `runMigrations` after `migrate()` (under the same lock), not in a migration file.

**How `src/db/migrate.ts` adopts a MikroORM-era database** (production's first Drizzle boot). All of it runs on one connection holding `pg_advisory_lock(hashtext('closet:migrations'))`, so the server and `maintenance:reconcile` never migrate at once; the second waits, then finds nothing to do.

- `mikro_orm_migrations` exists: its rows must include `LAST_LEGACY_MIGRATION` (`Migration20260926021506`, the newest file in `src/dal/migrations/postgres/`), or boot fails with `LegacyMigrationsIncompleteError` (boot a pre-Drizzle build once to finish them). Then, if `drizzle.__drizzle_migrations` has no row for the baseline (`drizzle/0000_baseline.sql`, the full schema as MikroORM left it), the runner inserts the row drizzle's migrator would have written (hash and `created_at` from drizzle-orm's own `readMigrationFiles`) without running the SQL.
- No `mikro_orm_migrations`: a fresh database; the baseline runs like any migration.
- Then drizzle's `migrate()` applies anything newer. The log says which: baseline recorded, `Applied N Drizzle migration(s)`, or `Schema up to date`.
- `mikro_orm_migrations` stays in legacy databases (hidden from drizzle-kit by `tablesFilter`). Once MikroORM is gone and production is past the baseline, the legacy check and `test/support/legacy-migrations.ts` go too.

## Deployment

Runs as the `closet` stack on the homelab NAS (`agandhi4/homelab`, `/volume1/docker/homelab` on the NAS). Same shape as `orbit` and `finplat`: one container from a GHCR image, joined to `homeinfra_web`, fronted by the shared Caddy.

| Piece | Value |
|-------|-------|
| URL (canonical, PWA) | `https://closet.kashhq.dedyn.io` |
| URL (HTTP twin) | `http://closet.box` (no service worker or push here; secure context required) |
| Image | `ghcr.io/agandhi4/closet:latest`, amd64, published by the `publish` job of `ci.yml` after the tests pass, on every non-docs push to `main` |
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
- **`ci.yml`'s `publish` job pushes `:latest` and `sha-<7>` only after `check`, `e2e` and `object-storage` pass** (and semver tags on `v*` tags from `tag-release.yml`), amd64 only, GHCR only. Until 2026-09-25 publishing was a separate workflow racing CI, so a red run still deployed. Docs-only pushes (`docs/**`, `*.md`) skip CI and publish entirely. Pushing to main is still deploying: the homelab autoupdater redeploys within the hour. The browser job runs with the PWA on, as production does; specs sign in through `test/support/e2e-session.ts`. Load test and Lighthouse run nightly (`nightly.yml`).
- **Upstream references are limited to attribution.** The only permitted mentions of the upstream project are the attribution link in the About page and README and code comments citing upstream issues or PRs. Any other occurrence of the upstream company or project name (assets, links, config defaults, CI values, marketing copy) is a rebrand regression; grep for it before a PR.
- **Regenerate `package-lock.json` only with Node 22 / npm 10** (`nvm use`, or `docker run --rm -v $PWD:/app -w /app node:22 npm install --package-lock-only`). npm 11 prunes nested entries that npm 10's `npm ci` in the Docker build then reports as missing, so the image build fails while local installs look fine.
- **pgvault-dev runs Postgres 18; production and CI run 17.** Features new in 18 pass locally and fail in CI.
- **`precommit:full` is minutes long** (Lighthouse and load test included); CI runs those two nightly, not per push.
- **Playwright serves whatever is on :3000.** The webServer command only starts `dist/` (the npm scripts build first); `reuseExistingServer` is on outside CI, so a running `start:dev`/`start:prod` is tested instead of the fresh build. Stop it before `verify:push`.
- **Integration specs boot one app per file.** `AppModule` reads `process.env` when it is first imported (Joi validation), so `createTestApp` sets the env and then imports `src/app`; a second `createTestApp` with different overrides in the same file would see the first env. Put a different config (`DISABLE_REGISTRATION`, `PWA_ENABLED`, ...) in a different spec file. Vitest runs every file in its own child process (the default `forks` pool with `isolate`), which is what keeps one file's env and app out of the next: never set `isolate: false` or `pool: 'threads'` on the integration project.
- **The integration harness is signed in by default.** `createTestApp` registers `owner@example.com` at boot and `t.inject` sends that session (`t.owner.cookie`) unless the request has its own `cookie` header or passes `anonymous: true`. A test about signed-out behavior must say `anonymous: true`; one that forgets asserts on the owner's view.
- **`@Public()` is the only way past `SessionGuard`, and static paths never have a session.** The preHandler in `app.ts` skips `static-prefixes.ts` paths, so a Nest route under one (`FileController`, `/healthz`, `/manifest.json`) always sees `req.auth` undefined and must be `@Public()`, or it answers every request with a login redirect. `@UserId()` on a `@Public()` route throws: a public handler reads `req.auth` itself if it cares (the invite landing page).
- **htmx does not swap 4xx/5xx responses** (its default `responseHandling`), boosted or not, and a boosted form's events fire on the body, not the form. A form whose refusal re-renders with a 4xx must be a native post (`hx-boost="false"`, as `views/auth/change-password.hbs`), or the user sees nothing. `delete-account`'s 401/400 re-render is still an `hx-post` and is invisible for that reason.
- **htmx reads only the first `<meta name="htmx-config">`.** Keep the config in one JSON object. `disableInheritance` is on, so any attribute that must reach descendants needs `hx-inherit` on the ancestor (the body has `hx-inherit="hx-boost"`; without it no link is boosted).
- **`public/build.json` lingers after `npm run build`.** `start:dev` then serves assets with that build's cache key; set `NODE_ENV=development` in `.env.local` (caching off) or delete the file if styles look stale.
- **Nest answers POST with 201 unless the handler has `@HttpCode(200)`**, even when it sends through `@Res()`: htmx partials, `HX-Redirect` replies and re-rendered forms (failed login, validation errors) all come back 201. Integration specs assert 2xx on those; browsers and htmx do not care.
- **Indexes and constraints are declared in `src/db/schema.ts`, never only in a migration file.** `drizzle-kit generate` diffs snapshots, not the database, so DDL hand-added to a migration is invisible to every later diff and the drift test reports it. Postgres does not index foreign keys on its own. `test/integration/migrations.spec.ts` lists the expected index names.
- **`patches/drizzle-kit+0.31.11.dev.patch` fixes `pushSchema` (`drizzle-kit/api`), which the drift test depends on.** Unpatched, its Postgres introspection drops query parameters (the composite primary key lookup fails with "there is no parameter $1") and reads a composite constraint's columns in no particular order, so `outfit_garments_pkey` and `wardrobe_share_grantor_id_grantee_id_unique` show up as drift. The CLI (`drizzle-kit pull`) shares the unordered query: check column order in anything it emits. The `.dev.patch` suffix is what makes patch-package skip it under `npm ci --omit=dev` (the Docker runtime stage); a plain `.patch` for a devDependency errors there and only passes while `CI` is unset. Re-check both bugs before bumping drizzle-kit; a version bump drops the patch.
- **`pg` is pinned to the exact version `@mikro-orm/postgresql` pins** (8.20.0), so there is one node-postgres copy. Bump them together.
- **The drift check ignores one legacy statement.** `tablesFilter` hides `mikro_orm_migrations` from drizzle-kit but not its serial sequence, which introspects as a standalone sequence that push would drop; `test/support/schema-drift.ts` filters exactly that `DROP SEQUENCE`. `drizzle-kit pull` against a legacy database emits a `pgSequence` for it: delete it, never add it to the schema.
- **Photo bytes are written before any row, and rows commit together.** `FileService.storeImageFromFileUpload` / `copyImage` return an unpersisted `File`; the caller (`GarmentService`) persists it inside `em.transactional` with the garment and calls `deleteVariants` if the transaction fails. `GarmentService.remove` and photo replacement delete the `File` row in the same transaction and unlink after commit. Do not `persistAndFlush` a `File` from inside `FileService`.
- **The DB cascade deletes rows, never bytes.** `deleteRule: 'cascade'` on `File.createdBy` and `Garment.owner` drops the rows when a user goes, but only `FileService.deleteVariants` removes the files. Every path that removes a `File` row (`GarmentService.remove`, photo replacement, `AuthService.deleteUser`) must unlink through the file service after commit; the cascade is the safety net and `StorageReconciliationService` (nightly, or `npm run maintenance:reconcile`) is the backstop that deletes photo sets and rows older than a day that nothing references. Outfits and calendar entries own no files.
- **HEIC uploads are buffered.** sharp's libvips has no HEIC decoder, so `image/heic`, `image/heif` and an `application/octet-stream` named `.heic`/`.heif` are read whole (capped by `MAX_HEIC_BYTES`, 413 past it) and decoded with heic-convert to a JPEG before the streaming sharp pipeline. libheif applies the container's rotation while decoding and the JPEG carries no EXIF, so HEIC photos are stored as decoded. Chrome/Android cannot decode HEIC in a canvas: `background-removal.js` skips the client cutout for such files and the form submits the original.
- **`/file/**` serves from DATA_PATH, which also holds `app.log`.** The route accepts only a photo base name as `parseStoredName` defines it (the same rule reconciliation uses); a looser "safe characters" regex served `/file/app.log`, session cookies included, on the public hostname until 2026-09-25. Never add a second definition of a stored name. `test/integration/file-route.spec.ts` covers it.
- **The request logger redacts `cookie`, `authorization` and `set-cookie`, and skips static paths.** The session cookie is a year-long bearer credential and the logs reach `app.log` and Loki. `autoLogging.ignore` must read `originalUrl`: Nest mounts pino-http as middleware, which strips the mount prefix, so `req.url` is `/` for every request.
- **`FileService.store` must be atomic.** Photo and cutout are written concurrently and the thumb writer reads whichever exists; the local backend writes to `DATA_PATH/.incoming/` and renames (S3 objects appear only when complete). Writing to the final name made every real photo+cutout upload fail with 500: the thumb step read a half-written cutout. Small flat-colour test fixtures always won the race; `test/integration/upload-race.spec.ts` uses a multi-MB noisy cutout. Boot removes `.incoming` entries older than an hour, never fresh ones (the reconcile CLI boots beside a live server).
- **A photo upload builds its thumb once, at the end.** `storeUploadedPhotoWithCutout` stores both halves with `deferThumb` / `newUpload` and then calls `regenerateThumb`; the mask edit path (`newUpload: false`) still rewrites the thumb before bumping the version.
- **Pipelines started inside a multipart `for await` loop must be armed with a no-op catch at creation.** `GarmentService.storeUploadedPhotoWithCutout` starts the photo and cutout pipelines without awaiting (an unconsumed part hangs busboy) and only settles them after the loop; a rejection while later parts are still being read (an undecodable HEIC/JPEG) was an unhandled rejection that exited the process with an empty reply. `startPipeline()` attaches the catch and returns the same promise, so the real error still surfaces from `Promise.allSettled`. `test/integration/heic.spec.ts` records `unhandledRejection` and asserts the app answers the next request. Node's default (crash loudly) is kept on purpose; do not add a process-level handler.
- **`bufferLogs: true` only flushes on `listen()`.** `createApp()` calls `app.flushLogs()` right after `useLogger`; without it an app that is only `init()`ed (the integration harness) buffers every Nest `Logger` call forever: nothing is emitted, `app.log` stays empty, and a `vi.spyOn(t.app.get(PinoLogger), 'warn')` sees zero calls whatever the app did. `test/integration/heic.spec.ts` asserts on such a spy and would catch a regression.
- **`ScheduleModule.forRoot()` lives in `MaintenanceModule`**, not `AppModule`: `StorageReconciliationService.onApplicationBootstrap` deletes the cron job when `MAINTENANCE_ENABLED=false`, which only works if the scheduler (a deeper module, bootstrapped first) has already registered it. The integration harness sets `MAINTENANCE_ENABLED=false`.
- **Register static roots with `app.register(fastifyStatic, …)`, not `app.useStaticAssets()`.** Both register the same plugin, but Nest 11's options type still describes `setHeaders(res)` as a raw response with `setHeader()`; `@fastify/static` 10 passes the `FastifyReply` (`reply.header()`) and applies it after `send`'s own Cache-Control, which is what makes the per-file policy in `registerStaticAssets` work. `test/integration/delivery.spec.ts` asserts the headers.
- **`test/support/legacy-migrations.ts` loads the MikroORM migrations through `dynamicImportProvider`.** MikroORM's default is an `import()` inside `node_modules`, which Vitest does not intercept: Node then loads the migration `.ts` itself with type stripping and fails on the extensionless import of `src/` code in `Migration20260925182919`. The provider's `import()` sits in our file, so Vitest's module runner handles it.
- **Vitest runs a function returned from `beforeEach`/`beforeAll` as that hook's cleanup.** `beforeEach(() => mock.mockReset())` returns the mock, so Vitest calls it after every test; with `mockRejectedValue` set, the test fails with the mock's rejection. Brace hook bodies that return anything. Jest ignored the return value.
- **`vi.mock` factories return the module namespace.** Mocking a CommonJS default export is `vi.mock('heic-convert', () => ({ default: vi.fn() }))`, and `vi.mocked(heicConvert)` types it; Jest's `() => jest.fn()` shape throws ("is not returning an object"). `vi.mock` is hoisted like `jest.mock`.
- **`calendar-dates.spec.ts` runs in America/New_York through its own project**, `unit-new-york` in `vitest.config.ts` (`env: { TZ }`, `pool: 'forks'`). Vitest assigns `env` to the worker's real `process.env` before importing the spec, and Node reloads the zone on that assignment in a child process; worker threads keep the parent's zone, so the project must stay on forks. The spec's first test asserts the offset. Another spec that needs a zone gets its own project the same way; it stays under `npm test` if its name starts with `unit`.
- **Vitest is pinned to `~4.0`.** Vitest 4.1 depends on Vite 8, whose optional peer chain (`@vitejs/devtools` back to `vitest`) crashes npm 10's resolver with "Cannot read properties of null (reading 'edgesOut')", and npm 11 lockfiles break the Docker build (see the lockfile gotcha). Bump only when `npx -y npm@10 install -D vitest@<new>` resolves, and prove the lockfile with `npm ci --dry-run` on npm 10.
- **`npm run typecheck` is the only type check.** `nest build` and Vitest both compile with SWC, which strips types without checking them. The root `tsconfig.json` covers `src/`, `test/`, `scripts/` and `vitest.config.ts` (no test globals: a helper that calls `expect` without importing it fails here, not only at runtime); the service worker has its own `views/assets/tsconfig.json` (WebWorker lib, strict) because it runs in a worker scope. It was 790 errors until 2026-09-25, one of them a live 500 (a misspelled MikroORM exception import is `undefined` at runtime, so `instanceof` threw).

## Workflow

<!-- ORCHESTRATION-OVERRIDE: claudebot agents skip this section.
     Your agent definition governs your workflow. -->

- Before implementing, search Graphiti with `group_ids: ["closet"]` for decisions and gotchas in the area.
- Plan in plain text and get approval before writing code or spawning implementers. Approval of a goal is not approval of an implementation.
- Behavior assertions go in `test/integration/` first: a spec that boots the real app and checks the HTML, headers, rows and files is the default proof that a change works, and it runs in seconds without a build or a browser. Playwright is the full gate for what only a browser can show (service worker, htmx swaps, layout).
- Every feature is still verified in a browser as an installed PWA on a phone-width viewport before it is called done. Type checks and tests verify code, not the app.
- Summarize changes and wait for an explicit go-ahead before committing. After an independent review and verification pass, commit in scoped commits and push straight to `main` (solo repo, no PR); a push to `main` publishes the image and the homelab autoupdater deploys it. The pre-commit hook runs `npm run check`; never bypass it with `--no-verify` to get a commit through. If a hook fails, fix and create a new commit, never amend.
- Commit messages: concise, why over what.
- When a new pattern or gotcha lands, update this file in the same commit and store the decision in Graphiti.
- Upstream sync: this fork will diverge (rebrand, household features). Keep upstream-worthy fixes in their own commits so they can be offered back to `lazztech/libre-closet`.
