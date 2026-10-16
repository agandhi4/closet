# Closet: architecture and simplification audit (2026-09-25, second pass)

Read-only pass over `/home/aakash/projects/closet` at `6a5e64f`. It does not repeat what already shipped: the SSE chat demo, the file-gallery routes, landing/privacy/terms, the single-session resolution, `resolveAccess`, image variants, indexes, transactional writes and storage reconciliation. Line numbers are from the working tree.

Every "zero callers" claim was checked with grep across `src/`, `views/`, `public/js/`, `test/` and `scripts/`. `npx tsc --noEmit --incremental false` ran without writing any files (see A4).

**Context that drives the ranking.** From project memory: one account exists, registration is locked, and "no wardrobe sharing planned yet". Production runs `AUTH_ENABLED=true`, Postgres and local file storage. Much of the code serves modes and features that no user reaches.

---

## Ranking summary

| # | Item | Leverage | Risk | Kind |
|---|------|----------|------|------|
| A1 | Web Push is dead end to end: delete it | very high | low | dead feature |
| A2 | Email password reset does not work in prod and leaks passwords to stdout: replace it with change-password | very high | low | dead feature + security |
| A3 | Throttler is a global no-op, and login has no rate limit | high | low | false safety |
| A4 | Five latent bugs; the type checker already finds one: gate `tsc` | high | low | reliability |
| A5 | Logging: `LOG_LEVEL=debug` is ignored, ANSI codes land in `app.log`, and `app.log` is never rotated | high | low | ops |
| A6 | Upstream residue: Cloudflare preconnect (an external request on every page), llms.txt, dead devDeps, dead config files | medium | very low | cleanup |
| B1 | The `AUTH_ENABLED=false` mode is a second product that prod never runs, yet it is what most tests exercise | very high | medium | structural |
| B2 | Wardrobe sharing: no users, a dead state, dominates the core controller | very high | medium (product call) | structural |
| B3 | Dual DB driver: go Postgres-only | high | medium | structural |
| B4 | S3 backend and the FileService interface layer | medium | low | dead feature |
| B5 | Open Graph share page: leaks the owner's email, plus a dead `type=file` branch and the watermark/ShareableId plumbing | medium | low | near-dead feature |
| C1 | calendar.service.ts: split out the pure date math, fix the UTC "today", move CSS out of the controller | medium | low | structure |
| C2 | Ownership checks in three shapes, plus a user re-query on every create | medium | low (after B1/B2) | duplication |
| C3 | wardrobe.controller.ts: triplicated option building, divergent color normalization, unvalidated write bodies | medium | low | duplication |
| C4 | Typed config, and one absolute-URL builder instead of four | medium | low | structure |
| C5 | Templates: navbar/dock in about 20 files, placeholder SVG ×9, a global page-only script | low-medium | very low | duplication |
| C6 | Outfit membership has two sources of truth (`slots` JSON + pivot) | medium | medium (migration) | data model |
| C7 | Inconsistent error handling; `req.auth` and `req.user` both exist | low-medium | low | structure |
| D | Tests: about 570 lines of "should be defined"; outfits and calendar have zero tests in any tier | high | low | tests |
| E | Tooling sprawl: duplicate workflow, `npm install` in CI, dead Tailwind config, split jest config, i18n × 6 | medium | very low | tooling |

A suggested order is at the end.

---

## A1. Web Push: provably dead end to end (delete)

**Evidence**
- **Subscribe never runs.** `public/js/pwa.js:60-63` subscribes only if `document.cookie` contains `access_token=`. That cookie is set `httpOnly: true` (`src/auth/auth.controller.ts:62`, `:97`), so JavaScript can never see it. `authenticated` is always false, and `webPush.subscribe()` is never called.
- **The only sender is a test endpoint with no UI.** `NotificationService.sendWebPushNotification` is called only from `POST /notification/test` (`src/notification/notification.controller.ts:46-56`). Its comment still says "Submitted by the htmx form on the chat page", and that page was deleted.
- **The service worker's payload contract doesn't match the server's.** `views/assets/src-sw.ts:179-220` reads `eventData.options` for body and icon. The server sends `{title, body, icon}` at the top level (`notification.service.ts` `sendWebPushNotification`), so the body and icon would be dropped even if a push were ever sent.
- **It still costs something.** VAPID keys are required whenever `PWA_ENABLED=true` (`src/app.module.ts:94-103`), so a PWA deploy must provision secrets for a feature that cannot fire. `lodash` is imported only for one `_.isEqual` (`notification.service.ts:7,58`).

**Root cause:** upstream boilerplate that was wired to the SSE chat demo. The demo is gone; the feature was never connected to anything in the wardrobe domain.

**What deleting it removes**
- `src/notification/` (controller 57, service 113, module 14, dto 5, specs 74+77 lines)
- `public/js/webPush.js` (46)
- the `web-push` entry in the importmap (`views/layout.hbs:76`)
- `pwa.js:58-69` (the subscribe block)
- the SW `push` listener (`src-sw.ts:175-220`)
- the `UserDevice` entity (35) and `User.userDevices`
- the `NotificationModule` import in `app.module.ts:11,222`
- Joi `PUBLIC_VAPID_KEY` and `PRIVATE_VAPID_KEY`, and the VAPID lines in the prod env and the CLAUDE.md deploy table
- the throwaway keypair in `test/integration/delivery.spec.ts:13-15`
- deps: `web-push`, `@types/web-push`, `lodash`, `@types/lodash`
- one migration pair dropping `user_device`

**Risk:** low. Nothing reads `user_device`. A migration pair is required (or two, if bundled with A2).

---

## A2. Email password reset: broken in prod, logs the new password, and is the only "change password" path

**Evidence**
- **Email is not configured in prod.** Prod env has no `EMAIL_*` (CLAUDE.md deployment block), and none of `EMAIL_TRANSPORT`, `EMAIL_FROM_ADDRESS`, `EMAIL_API_KEY`, `EMAIL_DOMAIN`, `EMAIL_PASSWORD` is in the Joi schema. That breaks the "Joi is the ONLY place config is declared" rule.
- **So the reset request always crashes.** With no transport, `EmailService.transporter` stays undefined (`src/email/email.service.ts:18-39`), and `sendMail` throws a TypeError (`:57`). `POST /auth/reset` always fails for a real email (`auth.controller.ts:139-152`).
- **The profile's "Change password" link goes there.** `views/auth/profile.hbs` links to `/auth/reset?email=…`, so production has no working way to change a password.
- **The real change-password code is dead.** `AuthService.changePassword` (`src/auth/auth.service.ts:85-94`) and `ChangePasswordDto` have zero callers; the i18n keys `CURRENT_PASSWORD` and `NEW_PASSWORD` are unused. It also silently no-ops on a wrong old password (returns undefined, no error).
- **The new password is logged in plaintext.** `auth.controller.ts:171` does `console.log(body)` in `postResetCodeValidate`. The body carries `email`, `resetCode`, `password` and `confirmPassword`.
- **The reset flow itself is unsound** if email were ever configured:
  - the pin never expires and is never consumed (`auth.service.ts:131-144`)
  - `POST /auth/reset-code` has no `@Throttle` (only the validate route does, `:164`, and that is a no-op anyway, see A3), so a 6-digit pin is brute-forceable
  - `postReset` reveals whether an account exists and interpolates the email into the redirect unencoded (`:143`)

**Root cause:** multi-tenant SaaS boilerplate (register, email reset) kept in a two-person app where the operator has direct database access (pgvault).

**Proposed change**
- Replace the reset flow with an authenticated change-password form: current, new and confirm password, using `changePassword`. Fix it to throw `UnauthorizedException` on a wrong old password.
- Handle forgotten passwords as an operator task: a `npm run user:set-password` CLI next to `reconcile.cli.ts`, or pgvault.

**What deleting it removes**
- `src/email/` (service 63, module 12, 2 dtos, spec 32)
- `views/email/password-reset.hbs`, `views/auth/reset.hbs` (50), `views/auth/reset-code.hbs` (79)
- four controller routes, `sendPasswordResetEmail`, `resetPassword`, `ResetPasswordDto` (39), `EmailDto`
- the `PasswordReset` entity (25), `User.passwordReset`, and `MikroOrmModule.forFeature([PasswordReset])` in three modules (auth, email, open-graph)
- deps: `nodemailer`, `nodemailer-mailgun-transport` (pulls in `mailgun.js`), `@types/nodemailer`, `@types/nodemailer-mailgun-transport`
- the direct `handlebars` import in `auth.service.ts:22`. `app.ts:11` only needs its types, which `hbs.handlebars` provides, so the `handlebars` dep can go too.
- the fake `EMAIL_*` values in every CI step (`.github/workflows/github-actions-ci.yml`)
- one migration pair dropping `password_reset` and `user.password_reset_id`

**Risk:** low. The flow cannot currently succeed in prod.

---

## A3. The throttler guards nothing

**Evidence**
- `ThrottlerModule.forRoot()` with no arguments (`app.module.ts:217`) defaults to `options = []` (`node_modules/@nestjs/throttler/dist/throttler.module.js:15`).
- `ThrottlerGuard.canActivate` loops over `this.throttlers`. The list is empty, so it returns `[].every(...) === true` for every request (`throttler.guard.js:59-97`).
- The `@Throttle({ default: … })` decorators on login and reset-code (`auth.controller.ts:86,164`) name a throttler that doesn't exist, so they are ignored.
- The global `APP_GUARD` still runs on every request (`app.module.ts:233-236`).
- The first audit's "Finding 3" (every client bucketed behind Caddy's IP) was wrong: nothing is counted at all. `TRUSTED_PROXIES` was partly justified by it (`app.ts:39-43`).

**Root cause:** boilerplate registered the module without configuring it. No test asserts a 429.

**Options**
- **(a) Recommended: real login protection only.** Use `ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 10 }])`, drop the global `APP_GUARD`, and put `@UseGuards(ThrottlerGuard)` on `postLogin` (and the change-password POST from A2). Add one integration spec asserting a 429 on the sixth bad login. That needs `app.inject` with `remoteAddress`, or `X-Forwarded-For` from a trusted proxy.
- **(b) Delete the throttler.** Remove `@nestjs/throttler`, the guard provider and the decorators, and say so in CLAUDE.md. Defensible only if the HTTPS name is tailnet-only. That is not verifiable from the repo: a DSM reverse-proxy rule exists for `closet.kashhq.dedyn.io`, so confirm whether port 443 is forwarded from the WAN.

---

## A4. Five latent bugs, and the type checker already catches one

**Bug 1: `wardrobe-share.service.ts:1,104` imports `UniqueConstraintException` from `@mikro-orm/core`.**
- The class is `UniqueConstraintViolationException`. `grep` in `node_modules/@mikro-orm/core` (6.6.14) finds only that name. The import is `undefined` at runtime.
- `e instanceof undefined` throws `TypeError: Right-hand side of 'instanceof' is not callable`. Any unique-constraint failure in `acceptInvite` becomes a 500 instead of the intended 400.
- `tsc` reports it as TS2305.

**Bug 2: cloning silently drops `washingDetails` and `dateAquired`.**
- `views/wardrobe/form.hbs:99,110` posts both fields in clone mode.
- `WardrobeController.cloneCreate`'s body type omits them (`wardrobe.controller.ts:321-353`), and so does `GarmentService.clone`'s dto (`garment.service.ts:154-186`).

**Bug 3: keyword search is case-sensitive in production only.**
- `garment.service.ts:75-82` uses `$like`. On SQLite (dev and the default test tier), `LIKE` is case-insensitive for ASCII; on Postgres (prod) it is case-sensitive, so "shirt" does not find "Shirt" in prod.
- The only test (`test/integration/delivery.spec.ts:141`) searches with the exact case.
- Fix: use `$ilike` (MikroORM maps it to `LIKE` on SQLite). This is a concrete example for B3.

**Bug 4: the brand filter is dead but still costs a query per page.**
- `SearchGarmentDto.brand` is validated and then ignored by `findAll`.
- `findAvailableFilters` runs a `SELECT DISTINCT brand` (`garment.service.ts:199-208`) on every wardrobe page and fragment. Nothing reads `filters.brands`: `wardrobe.controller.ts:115-132`; grep for `brands` in views finds nothing.
- Fix: either wire the brand filter into the UI or delete both.

**Bug 5: `AuthService.changePassword` succeeds silently on a wrong old password** (A2).

**Root cause for all of these:** nothing type-checks. CLAUDE.md admits it: `nest build` uses SWC, and ts-jest is transpile-only.
- `npx tsc --noEmit --incremental false -p tsconfig.json` reports **782 errors**. Most are specs missing jest types; the service worker needs the `WebWorker` lib.
- The non-spec errors include bug 1, plus nullability misuse in `open-graph.service.ts:43,68` and `app.ts:77-78`.
- The local `node_modules` is also stale: it lacks `@nestjs/schedule` and `heic-convert`.

**Proposed change**
- Add `tsconfig.spec.json` (jest types) and `views/assets/tsconfig.json` (`lib: ["WebWorker"]`).
- Fix the handful of real `src/` errors.
- Add `tsc --noEmit -p tsconfig.json` to `precommit` and to CI.

This is the single most trust-building change available: it turns "I don't trust the code" into a machine-checked floor. Once the config noise is gone, the real-error list is about 10 items.

---

## A5. Logging config is wrong in three ways

`app.module.ts:32-71` configures `pinoHttp.transport.targets` with two `pino-pretty` targets. Each has `level: 'info'` hardcoded (`:50,55`).

- **`LOG_LEVEL=debug` has no effect.** Each target filters at info, so debug lines, including every `logger.debug` added for timing (HEIC decode, thumb write), are never emitted. Only `LOG_LEVEL=silent` or a stricter level works.
- **`app.log` gets ANSI escape codes.** The file target spreads `colorize: true` into its options. `data/app.log` locally starts with `^[[32mINFO^[[39m …`.
- **`app.log` is never rotated.** CLAUDE.md says "rotating `app.log`", but there is no rotation (no `pino-roll`, no size cap). On the NAS it grows without bound in `DATA_PATH`, next to the photos. Docker already captures stdout, with its own rotation.
- `pino-pretty` has to live in production `dependencies` only because of this.
- Every request, static ones included, is auto-logged by `pinoHttp`.

**Proposed change**
- Production: plain JSON to stdout (Docker logs are the store), `level` from `LOG_LEVEL`, no file target.
- Development: a single `pino-pretty` transport.
- Consider `autoLogging.ignore` for `isStaticPath`.

**What it removes:** the file target, `pino-pretty` from runtime deps (it moves to devDeps), and a false line in CLAUDE.md.

**Risk:** low. If `app.log` is wanted for the NAS, use `pino/file` with JSON plus `pino-roll`, not pretty output.

---

## A6. Upstream residue (each item trivial)

**Cloudflare analytics**
- `views/layout.hbs:93` has `<link rel="preconnect" href="https://static.cloudflareinsights.com">`. Every page load opens an external connection (DNS plus TLS to Cloudflare). That violates the "installed PWA must boot with zero external requests" convention and leaks usage.
- The CSP still whitelists that host for `script-src` and `connect-src` (`app.ts:96`).
- Delete both.

**Unreferenced upstream files**
- `public/llms.txt` and `public/llms-full.txt`: an LLM crawler corpus for a private app whose robots.txt disallows everything. `llms-full.txt:64` also names the upstream project, which breaks the rebrand rule in CLAUDE.md.
- Deleting them also removes two `STATIC_FILES` entries (`src/static-prefixes.ts:23-24`) and a workbox ignore.
- `public/assets/screenshots/`: 6 of 8 files are unreferenced (only `Screenshot_1` and `Screenshot_mobile_1` appear in `app.service.ts:55,62`). That is about 580 KB in the image.
- `.github/agents/TDD.agent.md`, `.github/prompts/boilerplate.prompt.md` and `.vscode/mcp.json` are upstream Copilot/VS Code config. CLAUDE.md cites the prompt file for conventions; fold what is kept into CLAUDE.md and delete the file.

**Dead code (zero callers)**
- Service methods:
  - `GarmentService.findOneByShareableId` (`garment.service.ts:123`)
  - `OutfitService.findOneByShareableId` (`outfit.service.ts:61`)
  - `FileService.deleteById` (`file-service.abstract.ts:238`)
  - `WardrobeShareService.getAcceptedGrantorIds` (`wardrobe-share.service.ts:146`)
  - `AuthService.changePassword` (until A2 revives it)
- Handlebars helpers `join` and `ifContains` (`app.ts:298-308`).
- `ShareableId.flagged` and `.banned` (`src/dal/entity/shareableId.entity.ts:19-24`): never read or written. They are four columns, on user, garment, outfit and file, for a "reported content" moderation feature.
- `User.firstName` and `User.lastName` are read as display names but never written; no form sets them.

**Unused devDeps:** `ts-loader`, `chokidar` and `source-map-support` (grep finds them only in package.json).

**Other**
- `rxjs` must stay: it is a peer dependency of `@nestjs/core`.
- `class-validator` and `class-transformer` stay while any DTO validation exists (register, update-email, search).

---

## B1. `AUTH_ENABLED=false` is a second product

**Evidence**
- There are 36 auth-mode branches across `src/` and `views/`. The main shapes:
  - `userId != null ? { owner: { id: userId } } : { owner: null }` in `garment.service.ts:86-102,219`, `outfit.service.ts:33-43,51-57,86-89,107`, `calendar.service.ts:70,98-100,110,146,429-433`
  - an ownerless branch in `WardrobeShareService.resolveAccess` (`:174-184`)
  - three guards (`ConditionalAuthGuard`, `RequireSessionGuard`, `AuthGuard`) whose only difference is the `AUTH_ENABLED` branch plus redirect-vs-401
  - `authEnabled` conditionals in the navbar and profile
- Production runs `AUTH_ENABLED=true`. The integration harness defaults to `AUTH_ENABLED: 'false'` (`test/integration/harness.ts:32`). So `wardrobe.spec`, `writes.spec`, `filters.spec`, `colors.spec` and most of the photo lifecycle coverage exercise the ownerless code path that prod never takes.
- The e2e smoke gate runs with auth off too (`github-actions-ci.yml`, smoke steps).
- `userId?: number` threads through every service signature, and many call sites carry `as any` casts because of it.

**Root cause:** upstream's "zero-config `docker run`" goal (docs/DESIGN.md, MVP scope). A private household deploy never needs it.

**Proposed change**
- Make auth mandatory and delete `AUTH_ENABLED`.
- Keep one `SessionGuard`: it redirects page navigations and returns 401 for `fetch` routes. Decide which by route metadata or `Accept`, or keep two tiny guards with no config branch.
- Make `userId: number` everywhere, and write queries as `{ id, owner: userId }`.
- Change the harness default to auth on, with a `loginAs(t)` helper. `test/integration/auth.spec.ts` and `share.spec.ts` already register and log in.
- The owner columns can stay nullable in the database. First check prod for ownerless rows: `SELECT count(*) FROM garment WHERE owner_id IS NULL`, and the same for outfit and outfit_calendar; this is a read, allowed.

**What it removes**
- about 30 branches
- two of three guards, and roughly 150 of the 210 guard-spec lines (the `AUTH_ENABLED` cases)
- the `authEnabled` view flags and the ownerless doc comments
- a whole class of 403 paths ("ownerless vs owned")

**Risk:** medium. It touches every service signature, but mechanically. The integration tier must be flipped first, so it proves the auth-on path before the branches go.

---

## B2. Wardrobe sharing: a full feature with no users

**Evidence**
- Memory says "Single account only … No wardrobe sharing planned yet".
- `viewOwner`/`ownerId` appear **65 times in `wardrobe.controller.ts`**, 14 in `partials/wardrobe_main.hbs`, and 4+3 in `wardrobe/show.hbs` and `form.hbs`, mostly `{{#if viewOwner}}?ownerId={{viewOwner}}{{/if}}` repeated on every link and form.
- `WardrobeShare` is an implicit state machine spread over three nullable fields (`grantee`, `inviteToken`, `acceptedAt`), and it has a dead state:
  - `createInviteLink` only ever creates open invites with `grantee: null as any` (`wardrobe-share.service.ts:42-54`)
  - nothing creates a directed, grantee-set, unaccepted invite, so `getPendingShares` (`:128-133`) always returns an empty list
  - the manage page's "pending" section (`views/wardrobe-share/manage.hbs:81-131`) and the "sent to a different email address" branch (`:73-77`) are unreachable
- Transitions live in three methods with different cleanup:
  - `acceptInvite` merges into an existing share, upgrades VIEW to MANAGE, deletes the invite, and flushes twice (`:85-95`)
  - `declineInvite` doubles as "revoke open link"
  - `removeShare`
- The share permission comes from the request body with no validation: `body.permission || VIEW` (`wardrobe-share.controller.ts:77`). Any string is stored; an unknown value behaves as view-only.
- Error and label strings are hardcoded English, bypassing i18n: service exception messages, `'View only'`/`'Can edit'` (`wardrobe-share.controller.ts:112-113`), and error messages passed through the query string (`:143-145`).
- `declineInvite` swallows every exception (`:159-165`).
- Outfits and calendar ignore sharing entirely (`outfit.service.ts:46-59`, `calendar.service.ts:420-435`), so "share my wardrobe" shares garments only.

**Root cause:** an upstream feature built for strangers sharing wardrobes by invite link, kept in a household app.

**Options**
- **(a) Delete sharing. Recommended if no second account is imminent.**
  - Removes `src/wardrobe-share/` (service 223, controller 166, module 15, spec 90), three views (219 lines), the `WardrobeShare` entity plus a migration pair, `resolveAccess`, `RequestAccess`/`requireView`/`requireManage`, and every `ownerId` parameter and template suffix.
  - `wardrobe.controller.ts` drops roughly 40% of its lines, and `test/integration/share.spec.ts` goes.
  - If a partner gets an account later, a **household model** (every account in the household sees and edits one wardrobe) is far simpler than invite links. That could be a `household_id` on user, or just no per-user filtering at all.
- **(b) Keep it and make the state explicit.**
  - Add a `status` enum (`OPEN_INVITE`, `ACTIVE`) and delete the pending state and its view section.
  - Put one `transition()` method on the service (accept, revoke, remove).
  - Validate `permission` with `IsEnum` and move the strings to i18n.
  - Extend `resolveAccess` to outfits and calendar, or document why garments only.

---

## B3. Dual database driver: go Postgres-only

**What keeping both costs today**
- **Two migration trees.** `src/dal/migrations/sqlite` has 14 files (203 lines) and `postgres` has 13 (385), plus 83 KB of `.snapshot-*.json`. Every entity change needs two `migration:create` runs, and SQLite additionally needs a migrated `./data/sqlite3.db`. CLAUDE.md spends five gotcha paragraphs on this. The trees have drifted twice (missing FK indexes, `garment.color` as smallint).
- **Behavior divergence the fast tier hides.** Four known cases:
  - `LIKE` case sensitivity (A4, bug 3), a live production bug
  - SQLite auto-indexes ManyToOne columns, Postgres doesn't (the reason `@Index()` is mandatory)
  - the enum-to-smallint mapping only broke on Postgres
  - `CREATE INDEX CONCURRENTLY` and `allOrNothing` exist only for Postgres
  In each case the default, fastest tier is the one that doesn't match prod.
- **Code with a latent trap.**
  - `dal.module.ts` duplicates the whole options object per driver (`:24-95`).
  - The static driver pick at `:101-104` chooses **Postgres** when `DATABASE_TYPE` is unset, while the Joi default and the factory say sqlite. It only works because the factory's `driver` key overrides it.
  - The two CLI configs disagree: sqlite has `entities: src` and `entitiesTs: dist` inverted, migrations `path: dist`; postgres has `path: src` and an odd `pattern` regex (`mikro-orm.postgres.cli-config.ts`).
- **Dependencies.** `better-sqlite3` (27 MB native, rebuilt on every `npm ci`) and `@mikro-orm/better-sqlite`.
- **CI.** The integration tier runs twice, and smoke and load run on both drivers.
- **Joi.** The `DATABASE_*` conditional schema (`app.module.ts:113-151`).

**What sqlite buys:** `npm run test:int` in about 3 s with no Docker, and a zero-config `docker run` that this deployment doesn't use. There is no SQLite production data: prod has been Postgres since the 2026-09-25 deploy.

**Options and their costs**

| Option | What it takes | Cost |
|---|---|---|
| **A. Postgres-only; tests against a local Postgres (recommended)** | The harness already creates one database per spec from `TEST_DATABASE_URL` (`harness.ts:67-68,171`). Make that the only path. To keep it fast, migrate once into a template database, then `CREATE DATABASE spec_x TEMPLATE closet_tmpl` per file, which is a file copy instead of 13 migrations. Local dev and `start:dev` point at a `docker run postgres:17-alpine` (one command already documented) or a dev database on pgvault. | A Postgres must be running for `test:int` and `start:dev`. The tier gets somewhat slower; measure before and after, the template-DB copy should keep it near the current figure. |
| **B. PGlite in-process** (`@electric-sql/pglite` + `pglite-socket`, which exposes the wire protocol so the normal `PostgreSqlDriver` connects) | One PGlite instance per spec file in the harness, with no Docker. | **Unverified**: MikroORM 6/knex over pglite-socket, `CREATE INDEX CONCURRENTLY` and `DROP DATABASE … WITH (FORCE)` have not been tried. PGlite is single-connection, and MikroORM runs non-transactional migrations on a second connection. Worth a one-hour spike only if Docker locally is a real obstacle. |
| **C. Testcontainers** | A `@testcontainers/postgresql` global setup. | Needs Docker anyway, adds a dependency and container start-up per run, and gains little over A: CI already has a Postgres service. |
| **Keep both** | The status quo. | Every schema change pays twice, and the default test tier keeps masking prod behavior. |

**What A deletes**
- the sqlite branch of `dal.module.ts`, `IN_MEMORY_DB`, the WAL pragma, and `DATABASE_TYPE` plus its Joi conditionals
- `mikro-orm.sqlite.cli-config.ts`, `src/dal/migrations/sqlite/` and its snapshot
- `better-sqlite3`, `@mikro-orm/better-sqlite`
- the sqlite path in the harness and the `sqlite_master` branch in `test/integration/migrations.spec.ts:22`
- one CI integration job and the sqlite smoke and load steps
- three of the five migration gotchas in CLAUDE.md

**Risk:** medium, and it is all developer workflow; production is untouched. Do it before B1 and B2, so their migrations are written once.

---

## B4. S3 object storage backend

**Evidence**
- Production uses `FILE_STORAGE_TYPE=local`, yet `S3Module.forRootAsync` builds an S3 client on every boot ("S3Module dependencies initialized" is in `app.log`).
- It has hardcoded fallback credentials `'minio'`/`'password'` and endpoint `http://127.0.0.1:9000` (`src/file/file.module.ts:18-42`), duplicating and bypassing the Joi defaults.
- `S3FileService` (82) and its "should be defined" spec (53); `@aws-sdk/lib-storage` plus the transitive `@aws-sdk/*` (13 MB) and `@smithy/*` (6 MB); `nestjs-s3`.
- Six `OBJECT_STORAGE_*` Joi entries, the CI s3mock container, and the "remote" smoke and load steps.
- `FileServiceInterface` (`file-service.interface.ts`, 43 lines) re-declares the abstract class's public surface. Nothing depends on the interface rather than the class, so it adds nothing.
- The file-module log line `${process.cwd()}/${DATA_PATH}` is wrong for an absolute `DATA_PATH`.

**Proposed change**
- Delete the S3 backend.
- Keep the abstract `FileService` with its storage primitives (`get`, `store`, `delete`, `list`). They carry weight: `file-service.abstract.spec.ts` drives real behavior through an in-memory backend.
- Delete `FileServiceInterface` and move its doc comments onto the abstract class.
- Delete `deleteById`.

**Risk:** low. If off-box backup of photos is the real need, restic or Hyper Backup of `DATA_PATH` is the simpler tool.

---

## B5. Open Graph share page (`/share`)

**Evidence**
- `GET /share?shareableId=…&type=garment|outfit` is public and unauthenticated. Its "Copy link" buttons are in `views/wardrobe/show.hbs:303` and `outfits/show.hbs:95`.
- It publishes `ogDescription: "From <owner email>"` (`open-graph.service.ts:46,68,93`), so anyone holding a link sees the account email.
- The `type == 'file'` branch (`:35-51`) is dead. No link builds it, and the `ogUrl` it produces (`/file/<shareableId>`) would not resolve anyway: files are served by name, not shareableId.
- OG images go through `/file/watermark/:shareableId` (`file.controller.ts:48-54`) and `FileService.getByShareableId`/`getWatermark`/`watermarkImage` (`file-service.abstract.ts:247-250,368-416`), plus the `WATERMARK_ENABLED` flag.
- That endpoint is the only reason `File` extends `ShareableId`. `User` extends it too, and nothing reads `user.shareable_id`.
- The endpoint re-encodes the **original** to JPEG on every hit, while CLAUDE.md says OG uses the `nobg` variant.
- Both specs are wiring-only.

**Options**
- **(a) Keep the share link but simplify it.**
  - `ogImage` becomes the absolute `imageUrl(photo, 'nobg')` built from `SITE_URL`.
  - Delete the watermark route, `WATERMARK_ENABLED`, `getWatermark`/`watermarkImage`/`getByShareableId`, `FileUrlService`, the `type=file` branch, and `ShareableId` on `File` and `User`.
  - Drop the owner email from the description.
- **(b) Delete the feature** if links are never sent outside the household: the module (139 lines), `views/share.hbs` (74), the copy buttons, and the `shareableId` column on garment and outfit.

**Also:** with either option, drop `flagged`/`banned` (A6) in the same migration pair.

---

## C1. `calendar.service.ts` (458 lines)

**Evidence**
- Only about 100 lines are persistence: `findWeek`, `create`, `remove`, `toggleWorn`, `findOutfitOptions`, `findOneOwned`.
- The other roughly 300 lines are pure date math and view-model shaping with `I18nContext`: `buildIndexViewModel`, `getMiniMonthCal`, `buildCalendarWeeks`, `formatWeekLabel`, `calDays`, `calCellClass`, and CSS class names (`:157-418`).
- There are **zero tests of any kind** for this file or the controller (see D).
- A stale doc comment promises "annotates each entry with a repeat-wear warning" (`:59-63`); no such code exists, and the key `CALENDAR_WORN_RECENTLY` is unused.
- It mixes local and UTC time: `weekEnd.setDate(...)` (`:67`) is local, while everything else uses `setUTCDate`.
- **Correctness: "today" and `wornAt` use server UTC** (`:131,346,407`). For a household in a US time zone, after 5-8 pm local time the calendar highlights tomorrow as today, and marks worn on tomorrow's date. The container runs in UTC.
- `CalendarController.toggleWorn` builds CSS class strings and translated labels in the controller (`calendar.controller.ts:90-103`), and `create`/`toggleWorn` branch on raw `req.headers['hx-request']` (`:60,90`) instead of the shared `isFragmentRequest`. The first audit flagged both; they are still there.

**Proposed change**
- Split into `calendar.service.ts` (queries only) and `calendar-view.ts`: pure functions `(entries, anchor, today, i18n) → view model`, with no DI, so they are unit-testable without mocks.
- Pass `today` in, computed from a `TZ` config value (e.g. `APP_TIMEZONE=America/…`) rather than server UTC.
- Move the worn button's class and label into `partials/calendar_worn_button.hbs` behind `{{#if isWorn}}`.

**Risk:** low, provided a few pure-function specs are written first.

---

## C2. Ownership checks in three shapes

**Evidence**
- Garments go through `resolveAccess` (`garment.service.ts:105-121`).
- Outfits have their own `findOne` owner branch (`outfit.service.ts:46-59`); calendar has `findOneOwned` (`calendar.service.ts:420-435`).
- `WardrobeController.archive` and `remove` do their own inline check (`wardrobe.controller.ts:429-435,472-478`), even though the "one ownership resolver" commit claims all seven were replaced.
- `cloneForm` and `cloneCreate` rely on `findOne` and skip `requireView`.
- Create paths re-fetch the user row only to assign a reference: `userRepository.findOneOrFail(userId); outfit.owner = user as any` (`outfit.service.ts:86-89`, `calendar.service.ts:110-113`). `em.getReference(User, userId)`, or passing `owner: userId` to `create`, does the same without a query.

**Proposed change:** after B1 and B2, every lookup becomes `findOneOrFail({ id, owner: userId })`, which yields a 404 and makes existence and ownership one query. The three shapes collapse to one line each, and the `User` repository injections in the outfit and calendar services go.

---

## C3. `wardrobe.controller.ts` (484 lines)

**Evidence**
- The category option list is built three times, identically (`:154-161`, `:261-268`, `:303-310`).
- Color normalization appears three times with **different semantics**:
  - `create` splits comma strings and trims (`:190-195`)
  - `cloneCreate` and `update` only join arrays (`:347`, `:385`)
  - the declared body types lie: `color?: GarmentColor` actually receives `string | string[]`
- Write bodies are anonymous inline types with no validation; only the GET search has a DTO with `ValidationPipe` (`:94`). Colors are not validated on write even though CHANGELOG says "a validated string again", and custom colors are accepted (`editForm` computes `customColors`).
- `GarmentService.create` accepts `files`, but `create` never passes them (the photo is a separate `/photo` POST). `storeUploadedPhoto` (`garment.service.ts:348-362`) is reachable only from that dead parameter.

**Proposed change**
- One `GarmentFormDto` (class-validator, plus a `@Transform` that normalizes colors to `string[]` and joins them), used by create, update and clone.
- One `GarmentService.categoryOptions(ownerId, i18n)`.
- Delete the `files` path from `create`.

After B2 this controller should be about 200 lines.

---

## C4. Configuration is read in many places, with defaults re-declared

**Evidence**
- About 70 `configService.get('STRING')` calls across 22 files, with no typing and fallback defaults at call sites that contradict or duplicate Joi: `dal.module.ts:52-56` (`'postgres'`, `'localhost'`, 5432, `'postgres'`) and `file.module.ts:24-37` (`'minio'`, `'password'`, the endpoint).
- `process.env` is read outside `app.ts`: `dal.module.ts:102`, `app.module.ts:204,210`, `app.ts:231`, `main.ts:5` (`PORT` bypasses Joi's default).
- Undeclared keys are read (the `EMAIL_*` keys, A2).
- **Four different ways to build an absolute URL:**
  - `SITE_URL` (view-context `siteUrl`, used by the share-link copy buttons)
  - `req.protocol + req.host` (open-graph)
  - raw `x-forwarded-proto`/`x-forwarded-host` headers read directly (`view-context.service.ts:35-37`), which bypasses `trustProxy`, so any client can spoof the canonical URL
  - `req.headers.host` (wardrobe-share invite URLs, `wardrobe-share.controller.ts:62,79`)
- `ViewContextService` has two meanings of `baseUrl` (`:41` vs `:52`).

**Proposed change**
- A typed `AppConfig` built once from the Joi-validated env: a `ConfigModule` `load` factory or a small class, injected everywhere. Defaults live only in Joi.
- One `absoluteUrl(path)` helper from `SITE_URL`, since `SITE_URL` is already required in prod.

**What it deletes:** the call-site defaults and the header-derived URL code.

---

## C5. Template duplication

- `{{>navbar}}` and `{{>dock}}` are repeated in about 20 page templates instead of living in `layout.hbs`. A `hideChrome` flag would cover pages like `invite.hbs`.
- The "no photo" placeholder SVG (`M9 3.75H6.912…`) is copied 9 times across 7 files: `share.hbs` ×2, `partials/wardrobe_main.hbs` ×2, `outfits/index.hbs`, `outfits/show.hbs`, `outfits/form.hbs`, `wardrobe/show.hbs`, `partials/garmentModal.hbs`. Make it one `partials/photo_placeholder.hbs`.
- `/js/color-multiselect.js` loads globally on every page (`layout.hbs:61`), though only the garment form uses it. That breaks the "page-only libraries load from the page" rule.
- Hardcoded English outside i18n:
  - `views/outfits/show.hbs:72` ("No garments added yet.")
  - `views/email/password-reset.hbs` (goes with A2)
  - manifest shortcut names and descriptions (`app.service.ts:32-52`)
  - the wardrobe-share strings (B2)

---

## C6. Outfit membership has two sources of truth

**Evidence**
- `Outfit.slots` is a JSON column of `{category, garmentId}[]` (`outfit.entity.ts:32-33`). The `outfit_garments` pivot (`OutfitGarment`) holds the same membership.
- Only `OutfitService.create` and `update` keep them in sync (`outfit.service.ts:70-98,111-134`).
- Deleting a garment cascades the pivot row but leaves a stale `garmentId` in `slots`. `buildCategoryRows` tolerates that silently.
- Readers are split: the calendar and outfit list use the pivot, the edit form uses `slots`.

**Proposed change:** make the explicit pivot the single truth by adding `position` and `category` columns to `OutfitGarment`. Empty slots (category with no garment) need either a nullable garment on the pivot or a separate slot table. Then derive `slots` from it.

**Risk:** medium, because it needs a data migration. It is lower priority than everything above, and it gets easier once there is only one migration tree.

---

## C7. Error handling and request-state inconsistencies

- **Session state.** `req.auth` holds the session, and every guard copies `req.auth.payload` into `req.user` so the `@User()` decorator and controller `userId(req)` helpers can read it. The `userId` helper is duplicated in three controllers. Read `req.auth` directly: guards become pure predicates, `req.user` and the `fastify.d.ts` entry go.
- **`RegistrationGuard`** calls `response.redirect()` and then returns `false` (`registration.guard.ts`). Nest then throws `ForbiddenException` into `ErrorViewFilter`, which logs "Response already sent". Throw a redirect exception instead, as `RedirectToLoginException` does.
- **Four error styles:**
  - `AuthController` catches everything and renders the page with `error` (`:100-107,144-151,233-250`)
  - `WardrobeShareController` swallows errors (`declineInvite`) or pushes English messages into the query string (`acceptInvite`)
  - `WardrobeController`/`GarmentService` throw `HttpException`s, which `ErrorViewFilter` renders
  - `OutfitController.rowFragment` returns a bare 400
  Pick one: throw typed exceptions and let the filter render, with form re-render as the only local catch.

---

## D. Test suite

**Unit specs that only test wiring**, pure "should be defined" with everything mocked (~560 lines):
- `file-url.service.spec.ts` (18)
- `email.service.spec.ts` (32)
- `auth.service.spec.ts` (63)
- `open-graph.controller.spec.ts` (59)
- `open-graph.service.spec.ts` (57)
- `notification.controller.spec.ts` (74)
- `notification.service.spec.ts` (77)
- `s3-file.service.spec.ts` (53)
- `local-file.service.spec.ts` (53)
- `auth.controller.spec.ts` (83): mostly wiring plus a guard-metadata check, and that check dies with A2

They catch nothing the integration tier doesn't, and they break whenever a constructor changes. Most of them disappear with A1, A2, B4 and B5 anyway.

**Guard specs** (`auth`, `conditional-auth`, `require-session`, `registration`; 210 lines) mostly test the `AUTH_ENABLED` branch (B1).

**Unit specs worth keeping:** they test real logic or pure functions.
- `file-service.abstract.spec.ts`
- `heic.spec.ts`
- `image-variant.spec.ts`
- `image-url.spec.ts`
- `static-prefixes.spec.ts`
- `fragment-request.spec.ts`
- `auth-context.service.spec.ts`
- `postgres-indexes.spec.ts`
- `error-view.filter.spec.ts`
- the maintenance cron-guard spec

**Coverage gaps**, by grep of `test/integration` and `test/*.spec.ts` (behavior that matters and is untested in every tier):
- **Outfits:** no test hits `/outfits`, `row-fragment`, create or update from slots, or garment-ownership filtering (`findOwnedGarments`).
- **Calendar:** no test hits `/calendar`, the worn toggle, week navigation, or the "today" computation (C1).
- **Clone field loss** (A4, bug 2).
- **Postgres keyword search case** (A4, bug 3). It is only visible when the integration tier runs on Postgres with a mixed-case fixture.
- **Account flows:** no test of update-email or change-password (A2).
- **Share invites:** `share.spec.ts` covers VIEW and MANAGE acceptance, but not decline/revoke, accepting twice, or the unique-violation path that A4 bug 1 would turn into a 500.
- **Throttling** (A3): no 429 test.
- **Auth mode:** most integration specs run with auth off (B1). The smoke gate is a single test: the root redirects and the page renders.

**Proposed change**
- Delete the wiring specs.
- Flip the harness default to auth on.
- Add `outfits.spec.ts` and `calendar.spec.ts` to the integration tier (create, list, edit, schedule, toggle worn, week boundaries), plus pure unit specs for `calendar-view.ts` after C1.
- Once B3 lands, every behavior spec runs on the production database.

---

## E. Build and tooling sprawl

**CI and workflows**
- **`.github/workflows/playwright.yml`** duplicates CI. It runs the full Playwright suite on all five browser projects (`playwright.config.ts` projects) on every push, with auth and PWA off, while `github-actions-ci.yml` already runs the smoke gate and auth e2e. Delete it, or cut its matrix to Chromium plus Mobile Safari under `precommit:full`.
- **CI uses `npm install`, not `npm ci`** (`github-actions-ci.yml`, "npm install & build"). Lockfile drift is never caught, which contradicts the npm-10 lockfile gotcha. Also pinned to old actions: `actions/checkout@master`, `actions/setup-node@v1`.
- CI's `npx npm-check-updates` step is informational noise on every push.
- Lighthouse `upload.target: 'temporary-public-storage'` (`lighthouserc.js`) publishes every report to public storage, and Lighthouse runs on every push for a private app. Keep it under `precommit:full` only, and set `upload.target: 'filesystem'`.

**Dead or duplicated files and config**
- **`tailwind.config.js` is dead.** Tailwind v4 reads config from CSS (`@import "tailwindcss"; @plugin "daisyui";` in `views/assets/main.css`). There is no `@config` directive, so the JS file is ignored, yet the Dockerfile copies it (`docker/Dockerfile`, `COPY tailwind.config.js .`).
- **Jest config is split** between the `package.json` `"jest"` block (unit) and `jest.integration.config.js`. Use one `jest.config.js` with `projects: [unit, integration]`; `npm test` and `npm run test:int` select a project.
- **Two MikroORM CLI configs** disagree on paths (B3). After B3 there is one.
- **`scripts/preCommit.sh`** duplicates `precommit:full` plus `npm ci`. Keep one entry point.
- **`src/i18n/generated/i18n.generated.ts` is tracked despite being in `.gitignore`.** It is regenerated only under `NODE_ENV=development` (`app.module.ts:209-212`). Its value is the key typing in DTO validation messages, which is only enforced if `tsc` runs (A4). Either gate `tsc` and keep it tracked (remove the `.gitignore` line), or drop the generated types.

**package.json scripts**
- `lint` globs `{src,apps,libs,test}`; `apps` and `libs` don't exist (Nest monorepo boilerplate).
- `start` (`generate` + `nest start`) duplicates `start:dev`/`start:prod`.
- `generate:sw:watch` watches only the inject step, not the esbuild compile.
- `test:load:baseline` and `test:load:compare` exist on top of `test:load`.
- Each one is small, together they are noise; prune to about 12 scripts.
- `playwright.config.ts` imports `dotenv`, which is not a direct dependency; it works through a transitive install.

**i18n in six languages**
- `src/i18n/{de,es,fr,it,ru}/lang.json` are 216 lines each. Every new string means six edits, and the convention requires it.
- For a household app, confirm which languages anyone uses. If English only: keep `nestjs-i18n` (the `t` helper and validation messages work unchanged), delete five files (about 1,080 lines), and shrink the `OG_LOCALES` map (`view-context.service.ts:8-15`).
- About 11 keys are unreferenced: `PROFILE`, `CURRENT_PASSWORD`, `NEW_PASSWORD`, `FORCE_PWA`, `SW_UPDATE_PROMPT`, `NEW_OUTFIT`, `MASK_EDITOR_HINT`, `ALL_CATEGORIES`, `SELECT_AN_OUTFIT`, `CALENDAR_UNMARK_WORN`, `CALENDAR_NO_OUTFIT_PLANNED`, `CALENDAR_WORN_RECENTLY`. `CATEGORY_*` keys are used dynamically.

**Dockerfile**
- `CMD ["npm","run","start:prod"]` makes npm PID 1. Signals are forwarded poorly, which matters for the SIGTERM on autoupdate redeploys. Use `CMD ["node","dist/main"]`.
- The container runs as root. Add `USER node`.
- `patch-package` sits in runtime `dependencies` only so `postinstall` works in the runtime stage. Instead, run `npm prune --omit=dev` in the builder stage and copy `node_modules` across; then `patch-package` goes back to devDependencies.

**Already fine:** `coverage/`, `playwright-report/`, `test-results/`, `scripts/results/`, `dist/`, `public/sw.js`, `public/bundle.css`, `public/build.json` and `views/assets/src-sw.js` are all gitignored and not committed (`git ls-files` confirms).

---

## Suggested order

1. **Small fixes first (A4, A5, A6), with `tsc` gated.** Each item is a few lines and none needs a migration. Ship the case-insensitive search, the clone field fix, the exception import, the logging fix and the Cloudflare removal.
2. **B3 (Postgres-only)**, so every later schema change writes one migration.
3. **A1 + A2 + B5(a) + the `flagged`/`banned` columns** as one migration: drop `user_device`, `password_reset`, `user.password_reset_id`, `file.shareable_id` and the four `flagged`/`banned` pairs. Add the change-password form and the login throttle (A3a) at the same time.
4. **B1 (auth mandatory)**, with the harness flipped first.
5. **B2 (sharing: delete, or make it an explicit state machine)**, then C2 and C3 fall out mechanically.
6. **C1 (calendar split + timezone)** together with the missing outfit and calendar integration specs (D).
7. **C4, C5, C7, E** as cleanups; **C6** only if the data model starts causing bugs.

**Rough net effect of 1-5:**
- about 3,000 lines of TS, HBS and JSON deleted
- 10-12 runtime or dev dependencies removed: web-push, lodash, nodemailer, mailgun transport, the aws-sdk family, nestjs-s3, better-sqlite3, @mikro-orm/better-sqlite, handlebars (direct), plus unused devDeps
- about 16 env vars gone
- one migration tree, one auth mode, one guard shape
- a type-checked build
