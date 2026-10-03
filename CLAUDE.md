# Closet

Self-hosted digital wardrobe for the household: catalog garments (photo with background removal, category, brand, size, color), compose outfits, plan them on a calendar, and share a wardrobe with another user. Hard fork of Libre Closet (AGPL-3.0; no upstream remote or merges). Deployed on the homelab as `closet.box`. Stack and file detail: `docs/architecture.md`; what it used to be: `docs/history.md`.

**The primary interface is the installed PWA on phones.** Every feature must work as an installed, offline-tolerant app first and as a desktop web page second.

## Stack

Conventions: `backend.md`, `frontend.md`, `frontend-pwa.md`, `frontend-htmx.md` (hypermedia principles only; the Jinja2/FastAPI specifics do not apply)

- **Runtime**: Node 22 (`.nvmrc`), TypeScript, plain **Fastify 5** (no framework on top), built by `tsc` to `dist/`.
- **Views**: server-rendered typed JSX (`hono/jsx` to strings, no Hono server) in `src/web/`, htmx 2, a few modules in `public/js/`. Not a SPA; no JSON API for the UI.
- **CSS**: Tailwind v4 + daisyUI (`views/assets/main.css` to `public/bundle.css`; `views/assets/CLAUDE.md`).
- **Data**: PostgreSQL only (18 in production and locally, 17 in CI). **Drizzle ORM owns the schema, the migrations and every query** (`src/db/schema.ts`, `drizzle/`, applied at boot).
- **Auth**: a JWT in an httpOnly `access_token` cookie, into `req.auth` per request; `/mcp` takes personal access tokens. Every route that changes or hands out a credential asks for the current password (`src/web/auth/CLAUDE.md`).
- **PWA**: Workbox `injectManifest` over `views/assets/src-sw.ts` (to `public/sw.js`), Web Push via `web-push` + VAPID; gated by `PWA_ENABLED`.
- **Images**: `sharp`, `heic-decode`; background removal on the server only (BiRefNet, `onnxruntime-node`, a child process). Storage: local disk under `DATA_PATH`, the only backend.
- **i18n**: English only, `src/i18n/en/lang.json`, `t('KEY')` typed to its keys. **Logging**: one pino logger (`src/logger.ts`), a child per module.
- **Tests**: Vitest unit, Vitest integration (the real app in-process on a scratch Postgres database) and Playwright; `test/CLAUDE.md`.

## Architecture

```
src/
  app.ts          createApp(): migrations, pool, Photos, outbound fetcher, weather, then Fastify: root
                  hooks (same-origin at onRequest; rate limits; session + page context at preValidation,
                  skipped for static-prefixes.ts paths; security headers; request log), parsers, static
                  roots, error + not-found handlers, then webPlugin. Used by server.ts and the harness
  server.ts       serve(): createApp, the nightly and minute timers, the cutout queue, listen
  main.ts         production entry: loadConfig, createLogger, the model runner, serve()
  config.ts       loadConfig(), the only reader of process.env     logger.ts  createLogger()
  project-root.ts PROJECT_ROOT, valid from src/ and dist/
  random.ts       seededRandom(...key): the one seeded PRNG; never Math.random or the clock
  web/            plugin.ts, errors.tsx, render.ts, loggable-url.ts, i18n.ts, autosave.tsx,
                  page-cache.ts, view-context.ts, schemas.ts, layout/, security/, one dir per feature
  db/ maintenance/ metrics/ cutout/ wardrobe/ push/ weather/ seed/   each: see the area index
views/assets/     main.css, src-sw.ts, fonts.css
public/           sw.js, bundle.css, vendor/, modules/, js/, assets/ (generated from icon.svg)
test/             Playwright specs; support/, integration/: test/CLAUDE.md
drizzle/          generated migrations + meta/ (journal, snapshots)
docs/             DESIGN.md (upstream entity model: assess feature work against it), architecture.md,
                  web-layer.md, conventions.md, history.md (this file's detail, read on demand)
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
| Snap strip | `src/web/strip/CLAUDE.md` | the scroll-snap carousel (`SnapStrip`, `snap-strip.js`) Styling and the plan review share |
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

`src/web/weather/CLAUDE.md` and `src/web/push/CLAUDE.md` only point to Weather's and Web Push's docs. `npm run docs:check` (in `npm run check`) holds this file to 30 KB and each area doc to 16 KB, and this index to the docs on disk.

### Routes

In full: `docs/architecture.md#routes`. `GET /` is Today; no landing, privacy, terms or sitemap routes. Public (`config: { public: true }`): login, registration, logout (POST, and the GET that asks), `/about` (upstream attribution), `/offline.html`, `/healthz`, `/manifest.json` (from config, not a static file), `/.well-known/*`, `/share`, `/wardrobe-share/invite/:token`, and every `/file/**` image except an outfit selfie's (a 404 to anyone). `/mcp` takes a personal access token, never the cookie (`config: { bearer: true }`). Everything else needs a session and is the user's own; the area index names each owner (`/laundry` Wears and washes; `/wardrobe/insights` Insights; `/wardrobe/plans`, `/wardrobe/shopping`, `/auth/profile/style` Wardrobe plans; `/calendar/plan-week`, `/auth/profile/week` Weekly auto-plan; `/trips/*`; `/outfits/ideas` Outfit gallery; `/styling`; `/today/*`; `/selfies/*` Outfit selfies). `/offline/warm` is the service worker's warm list, the session's own wardrobe (PWA and the service worker). `/weather/*` exists only with `WEATHER_ENABLED`, `/push/*` only with `PWA_ENABLED`.

### Request flow

Root hooks in `app.ts` (same-origin at onRequest; `req.auth` and `ViewContext` into `reply.locals` at preValidation, skipped on static paths), then a route (`requireSession` → schema validation, 400 page on failure → handler → `renderPage`/`renderFragment` → `Layout`), or a static file (`@fastify/static`, precompressed, cache policy `src/static-assets.ts`), or the not-found handler (`HttpError(404)` into the error handler: the 404 page, or `{ statusCode, message }` on a static path). Every response gets the security headers (root onSend) and, off static paths, one log line (onResponse). A route serving a page and a fragment uses `wantsFragment(request, reply)` (`isFragmentRequest`, shared with the service worker, plus `Vary`).

### Web layer (adding a feature)

Each rule in full, with its story: `docs/web-layer.md`. A feature lives whole (routes, queries, views) in `src/web/<feature>/`, a plugin registered from `webPlugin` (`src/web/plugin.ts`). Integration specs driving HTTP are the proof that a change keeps behavior.

- **Routes**: `routes.tsx` exports a `FastifyPluginCallbackTypebox<WebOptions>`. Config arrives resolved as `WebConfig`; nothing in `src/web/` reads `Config` or `process.env`.
- **Validation**: TypeBox schemas (`@sinclair/typebox` 0.34; 1.x is ESM-only) on the route, never hand-parsing; a failure is the 400 page. A maybe-empty body is `Type.Union([Type.Object(...), Type.Null()])`. Say at the route whether bad input is a 400 (stored data) or a fallback (URL state, `?week=`).
- **Auth**: `requireSession` / `decideSessionAccess`: a navigation without a session is a 302 to `/auth/login`, an htmx request a bodiless 401 with `HX-Redirect`. User id: `sessionUserId(request)`, which throws on a public route. `config: { public: true }` is the only way past the gate, and a route under a `static-prefixes.ts` path never has a session, so must be public.
- **Queries**: Drizzle via `options.db` in `queries.ts`; specs assert rows through `t.db`. **Views**: a `.tsx` per page or fragment, `ctx: ViewContext`, `<Layout>`, `<AppBar>`, `<Dock>`, strings via `t('KEY', { param })`.
- **Navigation**: a tap is a boosted `<a href>` or an htmx request, never script setting `location` (`expectNoScriptNavigation`, `test/integration/pages.ts`). A write ending on another page answers `navigateTo(reply, path)`; `HX-Redirect` only for the 401 and the photo upload.
- **Rendering** only through `renderPage` / `renderFragment` / `renderToString` (`src/web/render.ts`), which await it: `String(<Page />)` can be `[object Promise]`. Specs read markup through `unescapeHtml`.
- **Errors**: `throw new HttpError(status)` (`src/web/errors.tsx`); the root error handler renders `ErrorPage`, anything else a detail-free 500. The root hook must stay at preValidation (validation runs after it, so a 400 keeps its page).
- **Hooks**: an async hook that answers must `return reply` or the handler sends again; one without async work takes `done` (`@typescript-eslint/require-await`). `createApp()` registers every root piece before `webPlugin`: a plugin inherits only what existed when it was registered.
- **Escaping**: the only raw-markup hatch is `dangerouslySetInnerHTML`, fed `tHtml()` or `jsonForScript()`, never a raw value, with a reason at each site. `hono/html` is banned by ESLint.
- **Forms**: every post form is `PostForm` (`src/web/auth/form.tsx`), a native post: htmx swaps no 4xx, and boosted forms lose password saving (`expectNativePostForms`); uploads too, never `hx-post`. It submits once (`public/js/submit-once.js`; `test/gallery.spec.ts`); the server stays the guard where a duplicate matters.
- **Autosave**: every control saved on change is built by `src/web/autosave.tsx` (`AutosaveForm`, `autosaveAttributes`), never by hand with `hx-trigger="change"` (`expectAutosaveControls`); **no other swap may replace an autosave form**, or its queued save dies (`test/autosave.spec.ts`).
- **htmx** reads only the first `<meta name="htmx-config">`; `disableInheritance` is on, so the body's `hx-inherit="hx-boost hx-indicator"` must stay.

### Request security

The detail of each rule, its code and its spec: `src/web/security/CLAUDE.md`. What every change keeps:

- **CSRF**: the root same-origin hook 403s a POST, PUT, PATCH or DELETE whose `Origin` (or `Referer`) is not this site, before the body is read. Nothing changes state on a GET. The harness sends an Origin; Playwright posts use `SAME_ORIGIN` / `signUpHeaders()`.
- **Rate limits** are per route, opt-in: `SIGN_IN_LIMIT`, `ACCOUNT_LIMIT` (every route that checks the current password), `LINK_IMPORT_LIMIT`, `WEATHER_SEARCH_LIMIT`, `WEATHER_LOCATION_LIMIT`, `MCP_LIMIT`.
- **Refusals do not reveal ids**: unseeable is a 404 like an unknown id; seeable but not changeable is a 403 (`WardrobeAccess`; the matrix is `test/integration/authorization-*.spec.ts`).
- **Outbound fetches** of a user-supplied URL or a third-party API go only through `createOutboundFetcher`.
- **Redirect targets** from the user go through `safeReturnTo`; a path carrying a secret sets `config: { secretPath: true }`; log lines name requests through `loggableUrl()`; public pages never show an email.
- **Sessions**: signing out is `POST /auth/logout`; a new password ends every other session, personal access token and push subscription.

### Config and logging

In full: `docs/conventions.md#config`, `#logging`. `loadConfig()` (`src/config.ts`) is the only reader of `process.env` (one TypeBox schema; a bad value stops the boot naming the key, never the value: `ConfigError`). Secrets have no default (`ACCESS_TOKEN_SECRET`: required, ≥ 32 chars). A new env var gets a schema entry and a README row. **The Docker image bakes `.env` and never sees `.env.local`**. Log through the module's pino child, at operation boundaries with ids, errors as `logger.error({ err }, message)`, never in rendering or loops.

## Conventions

In full: `docs/conventions.md`, `docs/web-layer.md#client-behavior`.

- **Server owns the HTML**: htmx attributes, then CSS, then a one-line inline handler reading `data-*`; bigger is a `public/js/` module with a reason in the PR. No `_hyperscript` (`expectFullPage` fails an `_=` attribute). **Locality of behavior**: view logic beside its markup.
- **Every user-facing string goes through i18n** (`t`/`tHtml`, `src/i18n/en/lang.json`).
- **daisyUI semantic tokens, no hardcoded colors** (ESLint: palette classes, `chip-N`, colours in `style`). Muted text is `text-muted`; `text-faint` never for text; ESLint refuses `text-base-content/0`–`/69`; no `opacity-*` on text.
- **No runtime CDN imports**: client packages from `public/modules/` (`CLIENT_MODULES`) or `public/vendor/`; zero external requests (`delivery.spec.ts`).
- **Postgres in every tier**; no second driver for test speed.
- **Cookies stay `Secure`-less** (`.box` is HTTP over Tailscale: `secure: true` breaks login); `SameSite=Lax` must stay (CSRF).
- **Offline-first per `frontend-pwa.md`**: cached reads show freshness; unreachable writes are disabled with a reason, never dropped; heartbeat, not `navigator.onLine`.
- **"Today" is `todayIn(APP_TIMEZONE, now)`** in app and tests (`t.today()`, `householdToday()`): a UTC date is tomorrow on a New York evening. ESLint's `no-restricted-syntax` refuses `toISOString().slice/substring/split` and `toLocaleDateString`; a new consumer gets a row in `test/integration/today.spec.ts`.

## Commands

```bash
nvm use                       # Node 22.20.0
npm ci                        # postinstall applies patches/ via patch-package

npm run start:dev             # tsc --watch + node --watch dist/main.js + tailwind --watch
npm run build                 # clean, tsc -p tsconfig.build.json (type-checks), generate (build-info, vendor, tailwind, sw, precompress)
npm run start:prod            # node dist/main.js (the image runs `node dist/main.js` as PID 1). Like start:dev it
                              # downloads the 940 MB model into MODELS_PATH (./models) on its first boot
npm run start:test            # the build with background removal stubbed (test/support/test-server.ts): what
                              # Playwright and Lighthouse start; never downloads the model
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
npm run audit:pages           # every page/action as the demo persona vs docs/perf/ (docs/perf/README.md)
npm run lighthouse            # lhci autorun

npm run test:all              # every Vitest project in one run (vitest.config.ts); test:cov adds v8 coverage in coverage/
npm run typecheck             # tsc: app + tests + scripts, then the service worker (~3 s cold)
npm run check                 # check:static (docs:check, format:check, lint:check, typecheck) and test:all in
                              # parallel (~80 s on 16 cores). The pre-commit hook. `precommit` is an alias.
                              # CI runs the halves as two jobs: `format, lint, types` and `unit + integration`.
npm run verify:push           # build + Chromium Playwright against the fresh build. The pre-push hook, only
                              # for a push to main (branches are verified by CI on their PR)
npm run precommit:full        # check + verify:push + page audit + lighthouse (minutes)

# Git hooks live in .githooks/ and are installed by `npm install` (the prepare script sets
# core.hooksPath; skipped where there is no .git, e.g. the Docker build). They need pgvault-dev; their quiet output: docs/git-hooks.md.

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

In full: `docs/conventions.md#tooling-gotchas`. The web layer's are rules under Web layer.

- **Never `prettier --write` a directory**: it re-pads the persona bibles (`src/seed/personas/*.md`) and the seed breaks (`persona.spec.ts`). Use `npm run format`.
- **Upstream references are attribution only** (About, README, comments citing upstream issues); anything else is a rebrand regression: grep before a PR.
- **`npm install <package>` skips our `postinstall`**, so `patches/` are unapplied and the drift test fails; run `npx patch-package` or `npm ci`.
- **Regenerate `package-lock.json` only with Node 22 / npm 10**: npm 11 prunes entries the Docker build's `npm ci` needs.
- **pgvault-dev and production run Postgres 18; CI runs 17.**
- **`public/build.json` lingers after `npm run build`**: stale styles in `start:dev`; set `NODE_ENV=development` in `.env.local` or delete it. `precommit:full` is minutes long.

## Workflow

<!-- ORCHESTRATION-OVERRIDE: claudebot agents skip this section.
     Your agent definition governs your workflow. -->

- **Backlog: GitHub issues, ordered by the pinned Roadmap (#27).** Pull the first unchecked item whose dependencies are done; its issue links to its design section in `docs/plans/` and lists the acceptance criteria. Open work and status live in issues, not in docs or memory. New ideas go in the **Later** milestone with where they were seen.
- Before implementing, search Graphiti with `group_ids: ["closet"]` for decisions and gotchas in the area.
- Plan in plain text and get approval before writing code or spawning implementers. Approval of a goal is not approval of an implementation.
- Behavior assertions go in `test/integration/` first: a spec that boots the real app and checks the HTML, headers, rows and files is the default proof that a change works, and it runs in seconds without a build or a browser. Playwright is the full gate for what only a browser can show (service worker, htmx swaps, layout).
- Every feature is still verified in a browser as an installed PWA on a phone-width viewport before it is called done. Type checks and tests verify code, not the app.
- **Changes land through pull requests** (owner decision, 2026-09-26). `main` is protected: the `format, lint, types`, `unit + integration`, `browser (production config)` and `codex-review` checks must pass, and the branch must be up to date with `main` (strict), which catches parallel branches that each pass alone (duplicate migration numbers, conflicting edits). Squash merges only: one PR is one commit on `main`, and merged branches are deleted.
- **The flow per issue slice:** a branch (`<issue>-<slug>`, e.g. `12b-bulk-edit`), in its own git worktree when agents work in parallel; the fast loop locally (the spec being worked on, and the pre-commit `npm run check`, ~80 s); push and open a PR that links the issue (`Part of #12` / `Closes #12`); the **local gate** verifies (2026-09-28: `local_gate.sh agandhi4/closet <pr>` in `~/.claude/scripts/agent-worker/` runs ci.yml's jobs on linux-box and posts the required statuses; Actions only publishes); an independent review of the PR diff; **Codex's go-ahead** (owner, 2026-09-27): `~/.claude/scripts/agent-worker/codex_gate.py wait agandhi4/closet <pr>` asks `@codex review` of the head commit and sets the required `codex-review` status. It passes once Codex reviewed that SHA and every thread is resolved. Answer each thread (`threads agandhi4/closet <pr>`, same script): fix what's valid or reply with the reason it isn't, then `reply <thread> "…" --resolve`. Every push needs a new `wait`. Docs-only PRs skip Codex (status "docs-only"); batch pushes to spare quota. **At its usage limit (`error`), an adversarial Claude review stands in** and, once addressed, sets `codex-review` success ("Claude adversarial review (Codex at limit)"); an update-branch merge carries a passed status over. Then `gh pr merge --auto --squash`, which merges once the checks pass. Merging publishes the image, then deploys. The owner may stop any PR (comment or close).
- **Phone-width checks** still happen before a feature is called done: Playwright at 390 px, run locally in the one worktree that is not racing another for `:3000`, or from CI's uploaded artifacts.
- **Migrations and parallel branches:** two branches that each generate `NNNN` collide in `drizzle/meta/_journal.json`. The later branch rebases on `main`, deletes its migration and snapshot, and regenerates (`npx drizzle-kit generate`); the drift test in CI proves the result. Never hand-merge a journal.
- The pre-commit hook runs `npm run check`; never bypass it with `--no-verify` to get a commit through. If a hook fails, fix and create a new commit, never amend. The pre-push hook runs the browser suite only for a push to `main` (a docs fix the owner pushes directly; admins can still push, the checks are not enforced on them).
- Commit messages: concise, why over what.
- When a new pattern or gotcha lands, write it in its area's `CLAUDE.md` (the area index; this file only for what every change needs) in the same commit and store the decision in Graphiti.
- No upstream sync: closet is a hard fork and never merges from Libre Closet. Restructure freely; offering a fix back upstream is optional, not part of the workflow.
