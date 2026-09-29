# Stack and architecture in full

Read on demand (not auto-loaded). The root `CLAUDE.md` keeps a short Stack list and architecture tree; this is the fuller description of each piece and each file. Moved out of the root in #259; what the stack used to be is in `docs/history.md`.

## Stack

Conventions: `backend.md`, `frontend.md`, `frontend-pwa.md`, `frontend-htmx.md` (hypermedia principles only; the Jinja2/FastAPI specifics do not apply)

- **Runtime**: Node 22 (`.nvmrc` pins `v22.20.0`), TypeScript, **Fastify 5**, plain: no framework on top (`FastifyReply`, `reply.setCookie`, Fastify plugins and hooks). NestJS left on 2026-09-26, the last step of the platform migration (Jest to Vitest, MikroORM to Drizzle, Handlebars to JSX, Nest to plain Fastify). Built by `tsc` (`tsconfig.build.json`, `src/` to `dist/`).
- **Views**: server-rendered HTML with htmx 2 for interactivity; the little client logic left is inline handlers and small modules in `public/js/` (`_hyperscript` was removed on 2026-09-26, see `docs/web-layer.md#client-behavior`). Not a SPA. There is no JSON API for the UI. Every page is typed JSX (`hono/jsx`, rendered to strings, no Hono server) in `src/web/` (see Web layer), the 404 and error page included.
- **CSS**: Tailwind v4 (`@tailwindcss/cli`) + daisyUI, source `views/assets/main.css`, compiled to `public/bundle.css`. The theme, the fonts and why the fonts step runs before Tailwind: `views/assets/CLAUDE.md`.
- **Data**: PostgreSQL only (18 in production on pgvault and locally, 17 in CI). **Drizzle ORM owns the schema, the migrations and every query** (`src/db/schema.ts`, `drizzle/`, applied at boot; see Changing the schema). The MikroORM and SQLite history and the legacy migration tree: `src/db/CLAUDE.md`.
- **Auth**: login is always required. A JWT in an httpOnly `access_token` cookie (never `Secure`, see `docs/conventions.md#conventions`), resolved once per request into `req.auth`; every route needs a session unless it says `config: { public: true }`, and `/mcp` takes personal access tokens instead. Every route that changes or hands out a credential asks for the current password. The session, the step-up rule, emails and password changes: `src/web/auth/CLAUDE.md`.
- **PWA**: Workbox `injectManifest` over a hand-written service worker (`views/assets/src-sw.ts`, esbuild to `.js`, injected to `public/sw.js`), `/manifest.json` served from config by `src/web/shell`, `@khmyznikov/pwa-install` (browser tabs that can install) and `pulltorefreshjs` (iOS standalone), both imported by `public/js/pwa.js` only where they apply, Web Push via `web-push` + VAPID keys (`src/web/push/`, see Web Push). Gated by `PWA_ENABLED`.
- **Images**: `sharp` for transcoding, `heic-decode` (libheif) for HEIC uploads. Background removal runs on the server only: BiRefNet 512x512 with `onnxruntime-node` in a child process (`src/cutout/`). The in-browser model (`@imgly/background-removal`, `onnxruntime-web`) and the `CUTOUT_MODE` switch were removed on 2026-09-26. See Architecture, Images and Background removal.
- **Storage**: local disk under `DATA_PATH`, the only backend (the S3 backend, `nestjs-s3` and the AWS SDK were removed 2026-09-26; production never used them).
- **i18n**: English only, strings in `src/i18n/en/lang.json` (the other five languages were deleted on 2026-09-26), read through `t('KEY')` from `src/web/i18n.ts`, typed to the catalog's keys.
- **Logging**: one pino logger (`src/logger.ts`), pino-pretty to stdout and to `app.log` under `DATA_PATH`, a child per module (`context`). See `docs/conventions.md#logging`.
- **Tests**: three tiers: Vitest unit, Vitest integration (`test/integration/`, the real app in-process on a scratch Postgres database) and Playwright e2e; see Test tiers under Commands, and `test/CLAUDE.md` for the harness.

## Architecture

```
src/
  app.ts               createApp(config, logger, options): migrations, the pool, Photos, the outbound
                       fetcher (options.outboundFetch: the specs' resolver and address policy only),
                       the weather service when WEATHER_ENABLED (options.weather: the tests' stand-in
                       for Open-Meteo only), then the Fastify instance:
                       root hooks (same-origin check at onRequest, rate-limit plugin, session resolution
                       and page context at preValidation, skipped for the static paths in
                       static-prefixes.ts; security headers; the request log line), cookie, compression,
                       form and multipart parsers, static roots, the error and not-found handlers, then
                       webPlugin. Shared by server.ts (listen) and the integration harness (ready + inject)
  server.ts            serve(config, logger, cutoutRunner, options): createApp, the nightly timers, the
                       push reminders' minute timer (with PWA_ENABLED), the week's re-plan minute
                       timer (always; the forecast part with WEATHER_ENABLED), the cutout queue started with
                       the runner, SIGTERM/SIGINT -> close, listen
  main.ts              the production entry: loadConfig + createLogger, the model's runner (ModelRunner,
                       model verified or downloaded at boot), serve()
  config.ts            loadConfig(): the TypeBox env schema (the ONLY place config is declared and the only
                       reader of process.env), .env.local then .env, typed Config. See `docs/conventions.md#config`
  logger.ts            createLogger(config) (stdout + app.log), createLoggerTo(level, stream) (tests)
  project-root.ts      PROJECT_ROOT for public/, drizzle/, node_modules/ paths; valid from src/ and dist/
  random.ts            seededRandom(...key): the one seeded PRNG (sfc32 over a SHA-256 of the key), for
                       the seed's history and the outfit generator; never Math.random or the clock
  web/                 Every route and page (see `docs/web-layer.md`): plugin.ts (registered by createApp),
                       errors.tsx (error page + handler), render.ts, loggable-url.ts, i18n.ts (t),
                       autosave.tsx (every form saved on change, see `docs/web-layer.md#autosave`),
                       page-cache.ts (what the service worker's page cache and the server share),
                       view-context.ts (the typed reply.locals and its builder), layout/ (JSX shell), and
                       one directory per feature, each in the area index below (sharing/:
                       /wardrobe-share/* and the access resolver; share/: /share, the public
                       share-link page, its Open Graph preview and the Share button). layout/parts.tsx: pieces the
                       garment, outfit and share pages share (thumb, back link, empty state).
                       schemas.ts: shared TypeBox pieces (RowId, IsoDateSchema).
                       security/: same-origin hook, rate limits, safeReturnTo, origin,
                       outbound-fetch.ts (the only fetcher of anything on the internet: user-supplied
                       URLs and the weather's fixed API) and public-address.ts (its address rule); see
                       Request security, Outbound fetches
  db/                  Drizzle: the schema and migration authority, and the query layer
                       (its files, the MikroORM adoption and the gotchas: src/db/CLAUDE.md)
  maintenance/         the nightly and minutely timers, storage reconciliation, the CLIs
                       (src/maintenance/CLAUDE.md)
  metrics/             Prometheus metrics, Server-Timing, the device timings: src/metrics/CLAUDE.md
  cutout/              Background removal (see Background removal):
                       src/cutout/CLAUDE.md
  wardrobe/            The garment model, pure (no database, web or strings): src/wardrobe/CLAUDE.md
  push/                The push reminders' schedule, pure: src/push/CLAUDE.md
  weather/             The weather, pure: src/weather/CLAUDE.md
  seed/                The seed personas: src/seed/CLAUDE.md
  i18n/en/lang.json    the English string catalog
views/
  assets/              main.css (Tailwind source), src-sw.ts (service worker source), fonts.css (the
                       webfonts' entry for `npm run generate:vendor`)
public/                Static: sw.js, bundle.css, vendor/, modules/, *.br/*.gz (generated), js/,
                       assets/ (icon.svg is the source; icon.png, icon-192.png, icon-512.png and
                       favicon.ico come from `npm run generate:icons`)
test/                  Playwright specs (the gate runs them in Chromium, the nightly in WebKit too; PWA on)
  support/, integration/  the harness and its helpers: test/CLAUDE.md
drizzle/               Generated migrations (NNNN_name.sql) + meta/ (journal, snapshots). Shipped in the image
docs/DESIGN.md         Upstream MVP design doc and entity model. Assess feature work against it.
```

## Routes

`GET /` is Today, the home screen (#15; signed out it sends to the login page like any page); there is no landing page, and no privacy, terms or sitemap routes. Public (`config: { public: true }`; reachable signed out): login, registration, logout (the POST, and the GET that asks first), `/about`, `/offline.html`, `/healthz`, `/manifest.json`, `/.well-known/*`, the Open Graph share page `/share`, the invite landing `/wardrobe-share/invite/:token`, and every `/file/**` image except an outfit selfie's (a 404 there, whoever asks). Everything else needs a session, except `/mcp`, which needs a personal access token and never reads the cookie (`config: { bearer: true }`, see MCP server). `/laundry` is the signed-in user's own hamper (see Wears and washes), and `/wardrobe/insights` their own figures (see Insights). `/wardrobe/plans`, `/wardrobe/shopping`, `/wardrobe/:id/plan-items` and `/auth/profile/style` are the signed-in user's own plans, shopping list, candidate links and style profile (see Wardrobe plans), and `/wardrobe/:id/outfit-count` their own wishlist item's "Goes with my closet" count (see Wishlist). `/weather/*` is the signed-in user's own weather and exists only with `WEATHER_ENABLED` (see Weather). `/calendar/plan` plans one more outfit on a day (see Calendar); `/calendar/plan-week` and its Undo, and `/auth/profile/week`, are the signed-in user's own weekly auto-plan and week template (see Weekly auto-plan). `/trips/*` are the signed-in user's own trips and packing lists, the Calendar's Trips tab (see Trips). `/outfits/ideas` is the Outfits page's Ideas tab, generated outfits to pick (see Outfit gallery). `/styling` is Styling, the outfit composer (see Styling); `/outfits/new` and `/outfits/:id/edit` only redirect into it. `/today/*` is Today's Refresh and "Wear this", the signed-in user's own day (see Today). `POST /calendar/:id/selfie`, `POST /selfies/:id/delete` and the images `GET /selfies/:fileName` and `/selfies/thumb/:fileName` are the signed-in user's own outfit selfies, served to them alone (see Outfit selfies). `/push/*` exists only with `PWA_ENABLED` (see Web Push). `/about` carries the upstream attribution. `manifest.json` is not a static file: `src/web/shell` serves it from config so `APP_NAME` and `ICON_NAME` flow into the installed PWA's name and icon.

## Request flow

Every request goes through the root hooks in `app.ts` (the same-origin check at onRequest; session into `req.auth` and `ViewContext` into `reply.locals` at preValidation, skipped on static paths), then:

- **A route** (`src/web/<feature>/routes.tsx`): the plugin's `requireSession` preValidation hook → the route's schema validation (400 page on failure) → the handler → `renderPage(reply, <FeaturePage ctx={viewContext(reply)} />)` or `renderFragment(...)` → JSX components in the shared `Layout`.
- **A static file** (`public/`; `/modules/*` is `public/modules/`): `@fastify/static`, precompressed, with the cache policy in `src/static-assets.ts`.
- **No route**: the not-found handler throws `HttpError(404, 'Cannot GET <url>')` into the error handler, which renders the 404 page (signed-in chrome included: the root hooks ran) or, on a static path, answers `{ statusCode, message }`.

Every response gets the security headers (root onSend) and, off the static paths, one log line (root onResponse).

htmx in the browser swaps fragments returned by further routes. A route that serves both a page and a fragment decides with `isFragmentRequest` from `src/htmx/fragment-request.ts` (shared with the service worker's cache keys) and sets `Vary`: in the web layer, `wantsFragment(request, reply)` does both.
