# Closet

Self-hosted digital wardrobe for the household: catalog garments (photo with background removal, category, brand, size, color), compose outfits, plan them on a calendar, and share a wardrobe with another user. Fork of Libre Closet (Lazztech, AGPL-3.0; repo `agandhi4/closet`, upstream remote `lazztech/libre-closet`). Deployed on the homelab as `closet.box`.

**The primary interface is the installed PWA on phones.** Every feature must work as an installed, offline-tolerant app first and as a desktop web page second.

## Stack

Conventions: `backend.md`, `frontend.md`, `frontend-pwa.md`, `frontend-htmx.md` (hypermedia principles only; the Jinja2/FastAPI specifics do not apply)

- **Runtime**: Node 22 (`.nvmrc` pins `v22.20.0`), TypeScript, **Fastify 5**, plain: no framework on top (`FastifyReply`, `reply.setCookie`, Fastify plugins and hooks). NestJS left on 2026-09-26, the last step of the platform migration (Jest to Vitest, MikroORM to Drizzle, Handlebars to JSX, Nest to plain Fastify). Built by `tsc` (`tsconfig.build.json`, `src/` to `dist/`).
- **Views**: server-rendered HTML with htmx 2 for interactivity; the little client logic left is inline handlers and small modules in `public/js/` (`_hyperscript` was removed on 2026-09-26, see Conventions). Not a SPA. There is no JSON API for the UI. Every page is typed JSX (`hono/jsx`, rendered to strings, no Hono server) in `src/web/` (see Web layer), the 404 and error page included.
- **CSS**: Tailwind v4 (`@tailwindcss/cli`) + daisyUI, source `views/assets/main.css`, compiled to `public/bundle.css`. The theme, the fonts and why the fonts step runs before Tailwind: `views/assets/CLAUDE.md`.
- **Data**: PostgreSQL only (17 in production on pgvault and in CI, pgvault-dev locally). **Drizzle ORM owns the schema, the migrations and every query** (`src/db/schema.ts`, `drizzle/`, applied at boot; see Changing the schema). The MikroORM and SQLite history and the legacy migration tree: `src/db/CLAUDE.md`.
- **Auth**: login is always required. A JWT in an httpOnly `access_token` cookie (never `Secure`, see Conventions), resolved once per request into `req.auth`; every route needs a session unless it says `config: { public: true }`, and `/mcp` takes personal access tokens instead. Every route that changes or hands out a credential asks for the current password. The session, the step-up rule, emails and password changes: `src/web/auth/CLAUDE.md`.
- **PWA**: Workbox `injectManifest` over a hand-written service worker (`views/assets/src-sw.ts`, esbuild to `.js`, injected to `public/sw.js`), `/manifest.json` served from config by `src/web/shell`, `@khmyznikov/pwa-install` (browser tabs that can install) and `pulltorefreshjs` (iOS standalone), both imported by `public/js/pwa.js` only where they apply, Web Push via `web-push` + VAPID keys (`src/web/push/`, see Web Push). Gated by `PWA_ENABLED`.
- **Images**: `sharp` for transcoding, `heic-decode` (libheif) for HEIC uploads. Background removal runs on the server only: BiRefNet 512x512 with `onnxruntime-node` in a child process (`src/cutout/`). The in-browser model (`@imgly/background-removal`, `onnxruntime-web`) and the `CUTOUT_MODE` switch were removed on 2026-09-26. See Architecture, Images and Background removal.
- **Storage**: local disk under `DATA_PATH`, the only backend (the S3 backend, `nestjs-s3` and the AWS SDK were removed 2026-09-26; production never used them).
- **i18n**: English only, strings in `src/i18n/en/lang.json` (the other five languages were deleted on 2026-09-26), read through `t('KEY')` from `src/web/i18n.ts`, typed to the catalog's keys.
- **Logging**: one pino logger (`src/logger.ts`), pino-pretty to stdout and to `app.log` under `DATA_PATH`, a child per module (`context`). See Architecture, Logging.
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
                       reader of process.env), .env.local then .env, typed Config. See Config
  logger.ts            createLogger(config) (stdout + app.log), createLoggerTo(level, stream) (tests)
  project-root.ts      PROJECT_ROOT for public/, drizzle/, node_modules/ paths; valid from src/ and dist/
  random.ts            seededRandom(...key): the one seeded PRNG (sfc32 over a SHA-256 of the key), for
                       the seed's history and the outfit generator; never Math.random or the clock
  web/                 Every route and page (see Web layer): plugin.ts (registered by createApp),
                       errors.tsx (error page + handler), render.ts, loggable-url.ts, i18n.ts (t),
                       autosave.tsx (every form saved on change, see Gotchas),
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
public/                Static: sw.js, bundle.css and vendor/ (generated), js/, assets/ (icon.svg is the
                       source; icon.png, icon-192.png, icon-512.png and favicon.ico come from
                       `npm run generate:icons`)
test/                  Playwright specs (CI runs all of them in Chromium with the PWA on)
  support/, integration/  the harness and its helpers: test/CLAUDE.md
drizzle/               Generated migrations (NNNN_name.sql) + meta/ (journal, snapshots). Shipped in the image
docs/DESIGN.md         Upstream MVP design doc and entity model. Assess feature work against it.
```

### Area index

Each area's detail lives in a `CLAUDE.md` beside its code. Claude Code loads one when a file in its directory is read; when planning work in an area, read its doc first. A "see Wardrobe" elsewhere means that area's doc.

| Area | Doc | Read it when the work touches |
| --- | --- | --- |
| Request security | `src/web/security/CLAUDE.md` | CSRF, rate limits, proxies, outbound fetches, redirects, logout, session revocation |
| Auth | `src/web/auth/CLAUDE.md` | the session, passwords, emails, the step-up rule |
| Images | `src/web/files/CLAUDE.md` | storing, serving, deleting or referencing photos, pending photos |
| Background removal | `src/cutout/CLAUDE.md` | cutouts, their state machine, the queue, the model child |
| Wardrobe | `src/web/wardrobe/CLAUDE.md` | garments: the grid, the form, properties, bulk edit, tagging, search |
| Link import | `src/web/wardrobe/link-import/CLAUDE.md` | adding a garment from a product link or Android's share sheet |
| The garment model | `src/wardrobe/CLAUDE.md` | the pure rules in `src/wardrobe/`, adding an occasion or a property value |
| Wishlist | `src/web/wishlist/CLAUDE.md` | the wishlist, a garment's status, "Bought it" |
| Wardrobe plans | `src/web/plans/CLAUDE.md` | plans, their gaps, the style profile, the shopping list |
| Capsules | `src/web/capsules/CLAUDE.md` | capsules and the capsule filter |
| Wears and washes | `src/web/wears/CLAUDE.md` | wears, washes, away, laundry, availability |
| Insights | `src/web/insights/CLAUDE.md` | the insights page |
| Sharing | `src/web/sharing/CLAUDE.md` | the access resolver; which surfaces are share-aware vs owner-only |
| Sizes | `src/web/sizes/CLAUDE.md` | sizes, body measurements, the brand hint |
| Seed personas | `src/seed/CLAUDE.md` | the seed, the persona bibles, demo data |
| Calendar | `src/web/calendar/CLAUDE.md` | the calendar, its entries and occasions |
| Trips | `src/web/trips/CLAUDE.md` | trips and packing lists |
| Outfit selfies | `src/web/selfies/CLAUDE.md` | selfies of worn entries |
| Weather | `src/weather/CLAUDE.md` | the forecast, climate normals, `/weather/*` |
| Outfits | `src/web/outfits/CLAUDE.md` | outfits, deleting one, what holds one |
| Styling | `src/web/styling/CLAUDE.md` | the outfit composer |
| Outfit gallery | `src/web/gallery/CLAUDE.md` | the Ideas tab and anything that suggests outfits (`ideasFor`) |
| Today | `src/web/today/CLAUDE.md` | the home screen |
| Weekly auto-plan | `src/web/week-plan/CLAUDE.md` | "Plan my week", the daily re-plan, `planned_by` |
| Web Push | `src/push/CLAUDE.md` | subscriptions, notifications, reminders |
| MCP server | `src/web/mcp/CLAUDE.md` | `/mcp`, its tools, personal access tokens |
| PWA and the service worker | `src/web/shell/CLAUDE.md` | the service worker, caching, offline, install, updates, static delivery |
| Styles and fonts | `views/assets/CLAUDE.md` | the theme, colours, fonts |
| Layout | `src/web/layout/CLAUDE.md` | the app bar, the dock, sections, stacking, a page's `<main>` |
| Database | `src/db/CLAUDE.md` | schema internals, drizzle-kit traps, the MikroORM-era adoption |
| Maintenance | `src/maintenance/CLAUDE.md` | the timers, storage reconciliation, the CLIs |
| Metrics | `src/metrics/CLAUDE.md` | `/metrics`, Server-Timing, the device timings, a new timer or label |
| Tests | `test/CLAUDE.md` | the integration harness, Playwright's server, Vitest traps |
| Deployment (not auto-loaded) | `docs/deployment.md` | production, its env, recovery, CI publishing |

`src/web/weather/CLAUDE.md` and `src/web/push/CLAUDE.md` only point to Weather's and Web Push's docs. `npm run docs:check` (in `npm run check`) holds this file to 48 KB and each area doc to 16 KB, and this index to the docs on disk.

### Routes

`GET /` is Today, the home screen (#15; signed out it sends to the login page like any page); there is no landing page, and no privacy, terms or sitemap routes. Public (`config: { public: true }`; reachable signed out): login, registration, logout (the POST, and the GET that asks first), `/about`, `/offline.html`, `/healthz`, `/manifest.json`, `/.well-known/*`, the Open Graph share page `/share`, the invite landing `/wardrobe-share/invite/:token`, and every `/file/**` image except an outfit selfie's (a 404 there, whoever asks). Everything else needs a session, except `/mcp`, which needs a personal access token and never reads the cookie (`config: { bearer: true }`, see MCP server). `/laundry` is the signed-in user's own hamper (see Wears and washes), and `/wardrobe/insights` their own figures (see Insights). `/wardrobe/plans`, `/wardrobe/shopping`, `/wardrobe/:id/plan-items` and `/auth/profile/style` are the signed-in user's own plans, shopping list, candidate links and style profile (see Wardrobe plans), and `/wardrobe/:id/outfit-count` their own wishlist item's "Goes with my closet" count (see Wishlist). `/weather/*` is the signed-in user's own weather and exists only with `WEATHER_ENABLED` (see Weather). `/calendar/plan` plans one more outfit on a day (see Calendar); `/calendar/plan-week` and its Undo, and `/auth/profile/week`, are the signed-in user's own weekly auto-plan and week template (see Weekly auto-plan). `/trips/*` are the signed-in user's own trips and packing lists, the Calendar's Trips tab (see Trips). `/outfits/ideas` is the Outfits page's Ideas tab, generated outfits to pick (see Outfit gallery). `/styling` is Styling, the outfit composer (see Styling); `/outfits/new` and `/outfits/:id/edit` only redirect into it. `/today/*` is Today's Refresh and "Wear this", the signed-in user's own day (see Today). `POST /calendar/:id/selfie`, `POST /selfies/:id/delete` and the images `GET /selfies/:fileName` and `/selfies/thumb/:fileName` are the signed-in user's own outfit selfies, served to them alone (see Outfit selfies). `/push/*` exists only with `PWA_ENABLED` (see Web Push). `/about` carries the upstream attribution. `manifest.json` is not a static file: `src/web/shell` serves it from config so `APP_NAME` and `ICON_NAME` flow into the installed PWA's name and icon.

### Request flow

Every request goes through the root hooks in `app.ts` (the same-origin check at onRequest; session into `req.auth` and `ViewContext` into `reply.locals` at preValidation, skipped on static paths), then:

- **A route** (`src/web/<feature>/routes.tsx`): the plugin's `requireSession` preValidation hook → the route's schema validation (400 page on failure) → the handler → `renderPage(reply, <FeaturePage ctx={viewContext(reply)} />)` or `renderFragment(...)` → JSX components in the shared `Layout`.
- **A static root** (`public/`, `/modules/*`, ...): `@fastify/static` with the cache policy in `registerStaticAssets`.
- **No route**: the not-found handler throws `HttpError(404, 'Cannot GET <url>')` into the error handler, which renders the 404 page (signed-in chrome included: the root hooks ran) or, on a static path, answers `{ statusCode, message }`.

Every response gets the security headers (root onSend) and, off the static paths, one log line (root onResponse).

htmx in the browser swaps fragments returned by further routes. A route that serves both a page and a fragment decides with `isFragmentRequest` from `src/htmx/fragment-request.ts` (shared with the service worker's cache keys) and sets `Vary`: in the web layer, `wantsFragment(request, reply)` does both.

### Web layer (adding a feature)

A feature lives whole (routes, queries, views) in `src/web/<feature>/`, a Fastify plugin registered from `webPlugin` in `src/web/plugin.ts`. The integration specs drive HTTP: they are the proof that a change keeps behavior.

- **Routes**: `src/web/<feature>/routes.tsx` exports a plugin (`FastifyPluginCallbackTypebox<WebOptions>`, or `FastifyPluginCallback` for a feature without input); add `app.register(featureRoutes, options)` to `webPlugin`. Config the routes need is resolved once in `createApp()` into `WebConfig`; nothing in `src/web/` reads `Config` or `process.env`.
- **Validation**: Fastify's own JSON-schema validation, schemas written with TypeBox (`@sinclair/typebox`, 0.34; `typebox` 1.x is ESM-only and the build is CommonJS) and request types inferred through `@fastify/type-provider-typebox`: declare `schema: { body, querystring, params }` on the route and `request.body` is typed from it. No class-validator DTOs, no hand-parsing in handlers. A request that fails the schema never reaches the handler: the error handler renders the 400 error page with Fastify's message (`body/date must match format "date"`). Fastify's ajv coerces form strings (`Type.Integer()` accepts `"12"`), strips unknown properties, and validates `format: 'date'` as a real calendar date (ajv-formats, full mode). A body the route may receive empty is `Type.Union([Type.Object(...), Type.Null()])` (Fastify validates a missing body as null). Decide per parameter whether malformed input is a 400 (data a write would store) or a fallback (navigation state in a URL, as the calendar's `?week=`), and say which at the route. Because the session hook and the root hook run at preValidation, an anonymous request is sent to log in before its input is judged, and a 400 has its page context.
- **Auth**: every route needs a session; `{ config: { public: true } }` opts out. `requireSession` (`src/web/auth/require-session.ts`) answers with `decideSessionAccess` (`src/web/auth/session-access.ts`): a page navigation without a session is a 302 to `/auth/login` and an htmx fragment or fetch a bodiless 401 with `HX-Redirect`. A handler reads the user from `request.auth` (always set past the hook on a non-public route).
- **Queries**: Drizzle, `options.db` (built in `createApp()`), in `src/web/<feature>/queries.ts`. A handler reads the user id with `sessionUserId(request)` (`src/web/auth/require-session.ts`). Row assertions go through `t.db`.
- **Views**: one `.tsx` per page or fragment beside the routes, typed against its data. Pages take `ctx: ViewContext` and render `<Layout>`, `<AppBar>` and `<Dock>` from `src/web/layout/`. Strings: `t('KEY', { param })`; a misspelled key is a type error.
- **Navigation**: a tap is a boosted `<a href>` or an htmx request, never script setting `location` (a full document load; `expectNoScriptNavigation` in `test/integration/pages.ts` fails any page that does). A card that holds a form (the calendar chip's delete) uses a stretched link: the card is `relative`, its link gets `after:absolute after:inset-0`, the form `relative z-10`. An htmx write that ends on another page (archive, delete) answers `navigateTo(reply, path)` (`src/web/render.ts`): `HX-Location` swapping the body with `HX-Boosted: true` on the follow-up GET, so the server and the worker treat it as the page it is. `HX-Redirect` reloads the document and is only for the 401 to the login page (the session is gone; start clean) and, until the photo flow is rebuilt, the photo upload.
- **Rendering**: `return renderPage(reply, <Page ctx={viewContext(reply)} />, { status })` (adds the doctype) or `renderFragment(...)`; both set `text/html; charset=utf-8` and throw instead of sending twice. JSX escapes `&` in attribute values (`href="...?a=1&amp;b=2"`, which the browser reads as `&`); specs that match URLs in markup read the body through `unescapeHtml` (`test/integration/harness.ts`). Void elements render as `<input type="hidden" name="x" value="1"/>`.
- **Errors**: `throw new HttpError(404)` (`src/web/errors.tsx`). The error handler (one, set at the root by `createApp()`) renders `ErrorPage` in the layout with the status: an `HttpError` or a Fastify 4xx keeps its message, anything else is a 500 without detail, logged with its stack. Without a page context (a static path, a body that failed to parse) the answer is `{ statusCode, message }`.
- **Logging**: `options.logger`, the `Web` child of the app's pino logger: `logger.info(message)`, `logger.warn(message)`, `logger.error({ err }, message)` (the error serializer keeps the stack). Name a request with `loggableUrl(request)`. The request line itself (`GET /about 200 5.6ms`) is the root onResponse hook's, context `Http`.
- **Escaping**: `hono/jsx` escapes every text child and attribute value, including text inside `<script>`. The one way to emit markup as-is is `dangerouslySetInnerHTML={{ __html }}`: grep for it, and every use needs a reason at the site. Feed it `tHtml(key, params)` (trusted template, escaped params) or `jsonForScript(value)` (inline JSON that cannot close its `<script>`), never a raw value. `hono/html` (`raw`, `html`) is banned by ESLint so there is no second hatch.

### Request security

The detail of each rule, its code and its spec: `src/web/security/CLAUDE.md`. What every change keeps:

- **CSRF**: the root same-origin hook refuses a POST, PUT, PATCH or DELETE whose `Origin` (or `Referer`) is not this site with a 403, before the body is read. Nothing changes state on a GET. Tools send an Origin: the harness does by default, Playwright posts use `SAME_ORIGIN` / `signUpHeaders()`.
- **Rate limits** are per route, opt-in: `SIGN_IN_LIMIT`, `ACCOUNT_LIMIT` (every route that checks the current password), `LINK_IMPORT_LIMIT`, `WEATHER_SEARCH_LIMIT`, `WEATHER_LOCATION_LIMIT`, `MCP_LIMIT`.
- **Refusals do not reveal ids**: what the requester cannot see is a 404 like an unknown id; what they can see but may not change is a 403 (`WardrobeAccess`; `test/integration/authorization-*.spec.ts` is the matrix).
- **Outbound fetches** of a user-supplied URL or a third-party API go only through `createOutboundFetcher`.
- **Redirect targets** from the user go through `safeReturnTo`; a path carrying a secret sets `config: { secretPath: true }` and every log line names requests through `loggableUrl()`; public pages never show an email.
- **Sessions**: signing out is `POST /auth/logout`; a new password ends every other session, personal access token and push subscription.

### Config

`loadConfig()` (`src/config.ts`) is the only reader of `process.env`: one TypeBox schema declares every variable with its default and rule, the values are merged from `.env` under `.env.local` under the real environment (the environment wins), booleans and numbers are converted only when they spell one exactly, and anything wrong stops the boot with every offending key named, never its value (`ConfigError`); `APP_TIMEZONE` must be an IANA zone and `PUBLIC_VAPID_KEY`/`PRIVATE_VAPID_KEY` are required with `PWA_ENABLED`. Secrets have no default: `ACCESS_TOKEN_SECRET` is required and at least 32 characters (the old `ChangeMe!` default let anyone who read the repo mint a session for any user id; the refusal says `openssl rand -hex 32`), and the database credentials are required too. Every process that boots the server passes one: the integration harness (`BASE_ENV`), `playwright.config.ts` (a random one unless the environment has it), the load test (random), CI and nightly (a CI-only value), `.env.local` for development. The result is a typed `Config` with the env names as keys (`config.DATABASE_HOST`), handed to `createApp()` and the CLIs, which pass slices on (`dbConfig`, `photosConfig`, `WebConfig`). `.env` is committed and holds public defaults; `.env.local` is gitignored and is for local development only. **The Docker image bakes `.env` and never sees `.env.local`**, so production configuration is real container environment variables, nothing else.

### Logging

`createLogger(config)` (`src/logger.ts`) is the process's pino logger: LOG_LEVEL for both outputs, pino-pretty in a worker thread to stdout and to `DATA_PATH/app.log` (flushed on exit), `cookie`, `authorization` and `set-cookie` redacted wherever a `req`/`res` is logged. Every module takes a child named for it (`logger.child({ context: 'Photos' })`; contexts: Bootstrap, Migrations, Db, Photos, Cutout, CutoutModel, Security, RateLimit, Session, OutboundFetch, Weather, Push, WeekPlan, Web, Http, Fastify, Mcp, Reconciliation, Scheduler, Metrics, SetPassword, RevokePush, Seed), so lines are filterable in app.log and Loki. Fastify gets the `Fastify` child (its own startup and internal warnings) with its request logging off: the root onResponse hook writes the one header-free line per request, skipping static paths.

## Conventions

Upstream rules we keep (from `.github/prompts/boilerplate.prompt.md`), plus ours:

- **Server owns the HTML.** Reach for htmx attributes first (`hx-get` on a form of its own, `hx-include`, the `form` attribute, a GET form that works without script), then CSS, then a one-line inline handler (`onclick`, `onsubmit`; the CSP allows inline script) with data from `data-*` attributes, never spliced in. A behavior bigger than a line lives in a module in `public/js/` loaded by the page that uses it, and needs a reason stated in the PR. `_hyperscript` (172 KB, the largest script in the shell) was removed on 2026-09-26: its 13 attributes were each a few lines of this; `pages.ts` fails a page with an `_=` attribute.
- **Locality of behavior.** Keep view logic beside its markup. Extract only when reused.
- **Every user-facing string goes through i18n.** `t('KEY')` (or `tHtml` for the few with markup) from `src/web/i18n.ts`; add the key to `src/i18n/en/lang.json`, the only catalog.
- **daisyUI components, not bespoke CSS.** Theme through daisyUI's semantic tokens. No hardcoded colors in templates: **enforced by ESLint** (Tailwind palette classes like `text-red-500`/`bg-white`, `chip-N`, and hex or colour functions in a JSX `style` are rejected). **Muted text is `text-muted`** (#88; `var(--color-muted)` in `main.css`'s own rules): the base content at 65%, the faintest tone that passes WCAG AA on base-100, base-200 and base-300 in both themes (4.79:1 at worst). `text-faint` (30%) is for decorative graphics only (a placeholder hanger where there is no photo), never text. ESLint refuses `text-base-content/0` to `/69`, so those two are the only ways below `/70`; don't dim text with `opacity-*` either (an archived tile dims its photo and says Archived).
- **No runtime CDN imports.** Every client dependency is an npm package served by the `@fastify/static` registrations in `app.ts` (`registerStaticAssets`), from node_modules or, when the package ships no minified ES module, minified from it at build into `public/vendor/` (`npm run generate:vendor`). The installed PWA must boot with zero external requests: no preconnect, and the CSP names no other origin (`delivery.spec.ts` checks both).
- **Config via `loadConfig()`**, never `process.env` anywhere else in `src/`. New env vars: a schema entry in `src/config.ts` with a default (a secret gets none: required, with a minimum), a row in the README configuration table. `APP_TIMEZONE` (default `America/New_York`) is the household's zone for everything that asks "what day is it" (the calendar today); an unknown zone name fails the boot.
- **One database: Postgres.** Every tier (integration, Playwright, load test, CI) runs on Postgres. Do not reintroduce a second driver for test speed: the scratch-database harness is as fast as in-memory SQLite was.
- **Cookies stay `Secure`-less.** The `.box` name is HTTP by design (Tailscale encrypts). Adding `secure: true` to `setSessionCookie` (`src/web/auth/session.ts`) makes login silently never stick over `http://closet.box`. `SameSite=Lax` is set and must stay (CSRF). If a secure cookie is ever wanted it must be driven by a `COOKIE_SECURE` env var defaulting to false.
- **Offline-first UX per `frontend-pwa.md`.** Reads render from cache with a freshness indicator, writes that cannot reach the server are disabled with an explanation, never silently dropped. Connectivity detection is active (heartbeat), not `navigator.onLine`.
- **Logging**: use the pino child the module was given (`logger.child({ context })` in `createApp()`). Log at operation boundaries with garment/outfit IDs and user IDs; errors as `logger.error({ err }, message)`. Nothing inside template rendering or loops.

## Commands

```bash
nvm use                       # Node 22.20.0
npm ci                        # postinstall applies patches/ via patch-package

npm run start:dev             # tsc --watch + node --watch dist/main.js + tailwind --watch
npm run build                 # clean, tsc -p tsconfig.build.json (type-checks), generate (build-info, vendor, tailwind, sw)
npm run start:prod            # node dist/main.js (the image runs `node dist/main.js` as PID 1). Like start:dev it
                              # downloads the 940 MB model into MODELS_PATH (./models) on its first boot
npm run start:test            # the build with background removal stubbed (test/support/test-server.ts): what
                              # Playwright, the load test and Lighthouse start; never downloads the model
# The CLIs run from dist/ (build first) and never migrate; their flags, and how to run them on linux-box:
npm run maintenance:reconcile # src/maintenance/CLAUDE.md, like user:set-password and push:revoke-all
npm run seed                  # src/seed/CLAUDE.md
npm run cutout:fetch-model    # src/cutout/CLAUDE.md

npm run lint                  # eslint --fix (src, test, scripts); lint:check is the no-fix, cached gate
npm run format                # prettier --write; format:check is the cached gate

# Test tiers, cheapest first
npm test                      # Vitest unit projects (unit, unit-new-york): mocked DB/fs, verifies wiring. ~1.5 s.
npm run test:watch            # the same in watch mode; test:debug waits for an inspector on :9229
(cd ../pgvault-dev && docker compose up -d --wait)
                              # every tier below needs Postgres: pgvault-dev on localhost:5432 (superuser
                              # postgres, trust auth). Dev app config lives in .env.local (DATABASE_*,
                              # closet_db, ACCESS_TOKEN_SECRET: the server refuses to boot without
                              # one); see README Development.
npm run test:int              # Vitest integration project: real app in-process, temp DATA_PATH, inject().
                              # Asserts HTML, headers, DB rows, files. ~5 s. No build needed.
                              # The default place for behavior assertions during development.
                              # Each spec file gets a scratch database (test/support/scratch-database.ts)
                              # on TEST_DATABASE_URL, default pgvault-dev; CI points it at a postgres:17 service.
npm run test:e2e              # build, then playwright (all browsers); start:test on :3000 unless one is running.
npm run test:e2e:smoke        # build, then the smoke spec in chromium
                              # the PWA specs skip unless the server runs with PWA_ENABLED: test/CLAUDE.md
npm run test:load             # builds, boots on a scratch database + temp DATA_PATH, autocannon
npm run lighthouse            # lhci autorun

npm run test:all              # every Vitest project in one run (vitest.config.ts); test:cov adds v8 coverage in coverage/
npm run typecheck             # tsc: app + tests + scripts, then the service worker (~3 s cold)
npm run check                 # check:static (docs:check, format:check, lint:check, typecheck) and test:all in
                              # parallel (~80 s on 16 cores). The pre-commit hook. `precommit` is an alias.
                              # CI runs the halves as two jobs: `format, lint, types` and `unit + integration`.
npm run verify:push           # build + Chromium Playwright against the fresh build. The pre-push hook, only
                              # for a push to main (branches are verified by CI on their PR)
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

`src/db/schema.ts` is the schema; `drizzle/` holds the migrations drizzle-kit generates from it. The server migrates on every boot (`createApp()`, before the pool opens and before anything queries), so a deploy is the migration. The CLIs never migrate: `requireCurrentSchema` refuses a database behind the build (`SchemaBehindError`, exit 1).

1. Edit `src/db/schema.ts`. Name new indexes and constraints the way the existing ones are (`<table>_<column>_index`, `_unique`, `_foreign`; MikroORM's names, kept). Every foreign key column gets an explicit `index()`, or leads a composite index or unique constraint (as `outfit_calendar.owner_id`): Postgres does not index them on its own. A composite name lists its columns in order (`outfit_calendar_owner_id_day_outfit_id_unique`).
2. `npx drizzle-kit generate --name <what-changed>` writes `drizzle/NNNN_<name>.sql` and `meta/NNNN_snapshot.json` from the diff against the last snapshot. Read the SQL: a rename it cannot tell from drop + add makes it prompt (run it in a terminal), and data fixes (backfills, deletes before `SET NOT NULL`) are hand-added to the generated file.
3. `npm run test:int`: `test/integration/migrations.spec.ts` asserts that drizzle-kit's `pushSchema` finds nothing to change after boot (a schema edit without its migration fails there, naming the missing statement) and lists the index names queries rely on.
4. Never edit or delete a migration that has shipped. Drizzle applies every file whose journal `when` is newer than the last row in `drizzle.__drizzle_migrations` and never re-checks hashes, so an edited file silently diverges from production.

## Deployment

Production runs on linux-box (the homelab) and merging to `main` deploys it: CI publishes the image and the hourly autoupdater pulls it. The pieces, the production env, the demo login, locked-out recovery, rotating the secret, deploying by hand and what CI publishes: `docs/deployment.md`.

## Gotchas

- **`prettier --write` on a directory formats the persona bibles too.** `src/seed/personas/*.md` are the seed's data; prettier re-pads their tables and the seed stops parsing (`persona.spec.ts` fails with "not a garment"). Format `"{src,test,scripts}/**/*.{ts,tsx}"` (`npm run format`), never a bare directory.
- **Upstream references are limited to attribution.** The only permitted mentions of the upstream project are the attribution link in the About page and README and code comments citing upstream issues or PRs. Any other occurrence of the upstream company or project name (assets, links, config defaults, CI values, marketing copy) is a rebrand regression; grep for it before a PR.
- **`npm install <package>` does not run the project's own `postinstall`**, so `patch-package` never applies `patches/` to a fresh `node_modules` built that way, and the drift test fails in drizzle-kit ("there is no parameter $1"). After adding a dependency to a new worktree, run `npx patch-package` (or `npm ci`, which does run it).
- **Regenerate `package-lock.json` only with Node 22 / npm 10** (`nvm use`, or `docker run --rm -v $PWD:/app -w /app node:22 npm install --package-lock-only`). npm 11 prunes nested entries that npm 10's `npm ci` in the Docker build then reports as missing, so the image build fails while local installs look fine.
- **pgvault-dev runs Postgres 18; production and CI run 17.** Features new in 18 pass locally and fail in CI.
- **`precommit:full` is minutes long** (Lighthouse and load test included); CI runs those two nightly, not per push.
- **`config: { public: true }` is the only way past the session gate, and static paths never have a session.** The root preValidation hook in `app.ts` skips `static-prefixes.ts` paths, so a route under one (`/file/**`, `/healthz`, `/manifest.json`) always sees `req.auth` and `reply.locals` undefined and must be public, or it answers every request with a login redirect. `sessionUserId()` on a public route throws: a public handler reads `req.auth` itself if it cares (the invite landing page).
- **htmx does not swap 4xx/5xx responses** (its default `responseHandling`), boosted or not, and a boosted form's events fire on the body, not the form. A form whose refusal re-renders with a 4xx must be a native post (`hx-boost="false"`, as every form in `src/web/auth/`: `PostForm`), or the user sees nothing. Native posts are also what makes browsers offer to save a password: a boosted registration let Firefox generate one and never save it, locking the owner out. Enforced: `expectNativePostForms` in `test/integration/pages.ts` fails any rendered page with a `<form method="post">` that is still boosted; in JSX use `PostForm` (`src/web/auth/form.tsx`), the only native-post form component. It caught three on 2026-09-26: the outfit save form, the garment form and the share revoke/leave buttons. It cannot see an `hx-post` form: the garment page's photo sheet was one (`hx-swap="none"`) and swallowed every refused upload (too large, not an image) until 2026-09-27; every upload form (the photo sheet, the add sheet, selfies) is a multipart `PostForm`. **Every `PostForm` submits once** (`data-submit-once`, `public/js/submit-once.js`, loaded by the layout on every page): a second submit while the first is in flight is cancelled, and the form's buttons (and those joined by `form=`) are disabled a tick after the submit (disabling the submitter in the submit event drops its `name=value` from the post), marked `submitDisabled` so only those are re-enabled: on a back/forward-cache return (`pageshow` persisted) and on an htmx request error. A control the offline guard or the page disabled is left alone. The server stays the guard where a duplicate matters (`pickIdea`); `test/gallery.spec.ts` taps twice during a slow post and counts one.
- **htmx reads only the first `<meta name="htmx-config">`.** Keep the config in one JSON object. `disableInheritance` is on, so any attribute that must reach descendants needs `hx-inherit` on the ancestor (the body has `hx-inherit="hx-boost hx-indicator"`; without it no link is boosted and no tap shows feedback). An element with its own `hx-indicator` replaces the inherited one, so the tapped link is no longer marked.
- **`public/build.json` lingers after `npm run build`.** `start:dev` then serves assets with that build's cache key; set `NODE_ENV=development` in `.env.local` (caching off) or delete the file if styles look stale.
- **Every form or control saved on change is built by `src/web/autosave.tsx`** (`AutosaveForm`, or `autosaveAttributes` for controls inside a larger form), never by hand with `hx-trigger="change"`: `expectAutosaveControls` (`test/integration/pages.ts`) fails a page with one. In htmx 2 a change made while the form's save is in flight is queued on the element that issued it and re-issued after the answer is swapped in, reading the form then; an answer that replaced that element (`outerHTML` on the section) silently dropped the queued save, and one that re-rendered the controls put back what the person had changed since (found on the push reminders' form, #15). The helper sets one queue per form, latest last (`hx-sync="closest form:queue last"`), posts the whole form each time, and answers the status line (`AutosaveSaved`) or, where the server must redraw controls (tagging's presets, the garment form's properties), a region's contents, never the element that posts; `public/js/autosave.js` (every page) drops an answer overtaken by an edit, whose own queued save lands instead. So every control in a redrawn region must itself post on change, and **no other swap may replace an autosave form** (its queued save would die with it): sibling writes answer regions beside it (the wear section's `#garment-wear-status`, the weather's `#weather-location` and `#weather-offset`). `test/autosave.spec.ts` changes each family several times on a slow network.
- **"Today" always comes from `todayIn(APP_TIMEZONE, now)`, in app code and in tests.** Never `new Date().toISOString().slice(0, 10)`, `toLocaleDateString` or a UTC getter: from 19:00 or 20:00 in New York until midnight that is tomorrow's date, on Saturday evening next week's, and a day after today cannot be marked worn (409). main went red at 00:01 UTC on Sunday 27 Sep 2026 because the authorization matrix planned its fixture entry on UTC's today; the same PR had passed before midnight UTC. Routes and tools call `todayIn(config.timeZone, new Date())` / `todayIn(ctx.timeZone, ...)`; integration specs use `t.today()` (the harness's app zone, read at the call so a faked Date moves it); Playwright specs use `householdToday()` (`test/support/household-today.ts`, the server's `loadConfig()` zone). ESLint's `no-restricted-syntax` refuses `toISOString().slice/substring/split` and `toLocaleDateString` in `src/`, `test/` and `scripts/`. `test/integration/today.spec.ts` pins the clock (`vi.useFakeTimers({ toFake: ['Date'] })`) where UTC and the household disagree: a UTC Sunday that is Saturday evening in New York, UTC midnight on a month boundary, the week and month turning on the day DST ends, New Year's Eve, and Auckland (ahead of UTC); it covers the calendar week and highlight, the plan page, worn and its 409, Wore today, Washed, laundry, "Bought it"'s purchase day, Today (#15: its plan, "Wear this", `get_today`) and the MCP tools. A new "today" consumer gets a row there.
- **hono/jsx types an element as its rendered string.** At runtime `<Page />` is a node whose `toString()` renders it and returns a Promise once any component is async; `String(<Page />)` can silently be `[object Promise]`. Render only through `renderToString`/`renderPage`/`renderFragment` (`src/web/render.ts`), which await it.
- **An async Fastify hook that answers must `return reply`.** `requireSession` returns `reply.redirect(...)`; sending without returning lets the handler run and send again. A hook that does no async work takes Fastify's `done` callback instead (`@typescript-eslint/require-await` rejects an `async` one without an `await`).
- **Errors before the root preValidation hook have no page context.** A body that fails to parse reaches the error handler with `reply.locals` unset, as does anything on a static path (the hook skips them), so both answer `{ statusCode, message }` with the right status instead of the page. A schema validation failure comes after the hook and gets the 400 page. The hook must stay at preValidation (not preHandler): validation runs between the two.
- **A Fastify plugin inherits only what its parent had when it was registered**: hooks, content-type parsers, decorators, the error handler. `createApp()` therefore registers every root piece (same-origin hook, rate-limit plugin, session hook, security headers, request log, cookie, compression, `@fastify/formbody`, multipart, the error handler) before `webPlugin`; one registered after it silently never applies to the routes (a form parser added late makes every urlencoded post a 415). The not-found handler is set at the root and runs the root hooks too, which is why a 404 page shows who is signed in.

## Workflow

<!-- ORCHESTRATION-OVERRIDE: claudebot agents skip this section.
     Your agent definition governs your workflow. -->

- **Backlog: GitHub issues, ordered by the pinned Roadmap (#27).** Pull the first unchecked item whose dependencies are done; its issue links to its design section in `docs/plans/` and lists the acceptance criteria. Open work and status live in issues, not in docs or memory. `gh` defaults to this fork (`gh repo set-default`); in a fresh clone run `gh repo set-default agandhi4/closet` first, or pass `-R agandhi4/closet`: the `upstream` remote makes `gh` target lazztech/libre-closet otherwise. New ideas go in the **Later** milestone with where they were seen.
- Before implementing, search Graphiti with `group_ids: ["closet"]` for decisions and gotchas in the area.
- Plan in plain text and get approval before writing code or spawning implementers. Approval of a goal is not approval of an implementation.
- Behavior assertions go in `test/integration/` first: a spec that boots the real app and checks the HTML, headers, rows and files is the default proof that a change works, and it runs in seconds without a build or a browser. Playwright is the full gate for what only a browser can show (service worker, htmx swaps, layout).
- Every feature is still verified in a browser as an installed PWA on a phone-width viewport before it is called done. Type checks and tests verify code, not the app.
- **Changes land through pull requests** (owner decision, 2026-09-26). `main` is protected: the `format, lint, types`, `unit + integration`, `browser (production config)` and `codex-review` checks must pass, and the branch must be up to date with `main` (strict), which catches parallel branches that each pass alone (duplicate migration numbers, conflicting edits). Squash merges only: one PR is one commit on `main` (an upstream-worthy fix gets its own PR), and merged branches are deleted.
- **The flow per issue slice:** a branch (`<issue>-<slug>`, e.g. `12b-bulk-edit`), in its own git worktree when agents work in parallel; the fast loop locally (the spec being worked on, and the pre-commit `npm run check`, ~80 s); push and open a PR that links the issue (`Part of #12` / `Closes #12`); CI does the full verification (failures: `gh run view --log-failed`); an independent review of the PR diff; **Codex's go-ahead** (owner, 2026-09-27): `~/.claude/scripts/agent-worker/codex_gate.py wait agandhi4/closet <pr>` asks `@codex review` of the head commit and sets the required `codex-review` status. It passes once Codex reviewed that SHA and every thread is resolved. Answer each thread (`threads agandhi4/closet <pr>`, same script): fix what's valid or reply with the reason it isn't, then `reply <thread> "…" --resolve`. Every push needs a new `wait`. Docs-only PRs skip Codex (status "docs-only"); batch pushes to spare quota. **At its usage limit (`error`), an adversarial Claude review stands in** and, once addressed, sets `codex-review` success ("Claude adversarial review (Codex at limit)"); an update-branch merge carries a passed status over. Then `gh pr merge --auto --squash`, which merges once the checks pass. Merging deploys (publish, then the hourly autoupdater). The owner may stop any PR (comment or close).
- **Phone-width checks** still happen before a feature is called done: Playwright at 390 px, run locally in the one worktree that is not racing another for `:3000`, or from CI's uploaded artifacts.
- **Migrations and parallel branches:** two branches that each generate `NNNN` collide in `drizzle/meta/_journal.json`. The later branch rebases on `main`, deletes its migration and snapshot, and regenerates (`npx drizzle-kit generate`); the drift test in CI proves the result. Never hand-merge a journal.
- The pre-commit hook runs `npm run check`; never bypass it with `--no-verify` to get a commit through. If a hook fails, fix and create a new commit, never amend. The pre-push hook runs the browser suite only for a push to `main` (a docs fix the owner pushes directly; admins can still push, the checks are not enforced on them).
- Commit messages: concise, why over what.
- When a new pattern or gotcha lands, write it in its area's `CLAUDE.md` (the area index; this file only for what every change needs) in the same commit and store the decision in Graphiti.
- Upstream sync: this fork will diverge (rebrand, household features). Keep upstream-worthy fixes in their own commits so they can be offered back to `lazztech/libre-closet`.
