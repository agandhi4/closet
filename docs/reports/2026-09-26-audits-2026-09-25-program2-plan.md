# Program 2 plan (2026-09-25)

## Status (2026-09-26): shipped

Phases 0, 1 and 2 are complete, the platform migration is complete (Fastify, Drizzle, typed JSX,
Vitest; Nest, MikroORM, Handlebars and Jest removed), and Phase 4 shipped its main items: the PWA
quick wins, server-side background removal (BiRefNet 512) with the in-browser model deleted, and the
move to linux-box. Summary and numbers: docs/PROJECT_LOG.md (2026-09-26). The sections below are the
plan as written, kept as the record of what was decided and why.

Still open (tracked as GitHub issues since 2026-09-26; the issues are the source of truth):
- #2 Stale-while-revalidate pages with a freshness indicator (and their cleanup on logout).
- #3 The unminified sortable (31 KB); #4 the install dialog's screenshots (a product call).
- #5 What Web Push is for (candidate: a morning reminder of today's planned outfit).
- Backups and Grafana's anonymous admin: issues in the private homelab repo.

Sources: the audit2-*.md reports in this folder; the homelab stack and backup report lives in the
private homelab repo (docs/audits/2026-09-25-closet-stack-and-backups.md) because this repo is public.
**Do not commit audit2-correctness.md until phase 0 is deployed**: it describes live exploits.

Order: stop live damage, make the gate real, fix correctness, simplify, then speed. Simplification
comes before speed on purpose: pagination, plain-row reads and the photo flow are all smaller once
auth-off mode, push, S3 and the extra languages are gone.

## Phase 0 — Live problems (today)

Closet hotfix, one commit each, integration tests first:
1. `/file/*` accepts only stored photo names, via the existing `parseStoredName` (one definition, used by
   the route and reconciliation). `/file/app.log` and `/file/sqlite3.db` return 404.
2. pino: redact `cookie`, `authorization`, `set-cookie`; no request log for static paths and `/healthz`.
3. Upload race: variants written to a temp name and renamed; thumbnail built once, after the cutout
   is complete. Real-size cutout in the integration test (the old 18 KB fixture hid it).
4. `UniqueConstraintException` import fixed (duplicate share accept 500 -> 400).
5. Remove `console.log(body)` in the reset controller (prints passwords).
6. `password_reset` FK: stop cascading a reset-row delete into the user (migration).

Owner actions after deploy: `deploy.sh update` on the NAS (updater is hourly), rotate
`ACCESS_TOKEN_SECRET`, delete `app.log*` under the closet data folder, purge closet logs from Loki,
turn off Grafana anonymous admin.

Backups and restore are a separate homelab effort (owner decision 2026-09-25), tracked in the private
homelab repo at docs/audits/2026-09-25-closet-stack-and-backups.md. Two app-side pieces stay in this
program: the reconciliation guard (refuse to delete when the file table is empty or shrank sharply,
plus a `MAINTENANCE_ENABLED` switch from the compose env) in phase 2, and `TRUSTED_PROXIES` covering
Caddy alongside the throttler fix.

## Phase 1 — Make the gate real

- CI: publish `needs:` the test jobs; docs-only commits skip publish; `npm ci`; npm and Playwright
  caches; Chromium only; merge playwright.yml into CI; pin actions by SHA; load test and Lighthouse nightly.
- `tsc --noEmit` clean (760 of 776 errors are missing jest types; 18 real) and gated.
- Real git hook (pre-commit ~5-6 s): cached prettier/eslint check (no `--fix`), incremental tsc,
  both jest tiers in one run. Pre-push ~25 s: one build + Chromium Playwright incl. auth and SW specs.
- Integration tier on Postgres only: done with the SQLite removal (scratch database per spec file).
- Cheap gates: i18n key parity, entity-vs-migration drift, template/partial references, `npm audit`
  high on prod deps (9 today: fix them).
- Coverage to every route: outfits, calendar, garment edit, password/email change, share revoke/
  decline, cross-user access denial for every ID-taking route. Delete the ~560 lines of
  "should be defined" unit specs.

## Platform decisions (owner, 2026-09-25) and how they fold into the phases

Decided: **Drizzle** replaces MikroORM, **plain Fastify** replaces NestJS, **Vitest** replaces Jest,
**background removal moves to the server**, and **Web Push stays** (to be fixed and given a use)
instead of being deleted. Done incrementally inside the phases, never as a big-bang rewrite:

- **Strangler, per feature.** NestJS already runs on Fastify, so a ported feature registers as a plain
  Fastify plugin on the same instance (`app.getHttpAdapter().getInstance()`) while unported features stay
  in Nest. Drizzle reads and writes the same Postgres database next to MikroORM. Each port lands with
  its Phase 2 fixes, so no data-access code is fixed twice.
- **Order:**
  1. Auth simplification in Nest (running; mostly deletions, and its public-route list and guard
     behavior carry over to a Fastify `onRequest` hook).
  2. **Foundation:** Vitest (decorator metadata via unplugin-swc while Nest remains; it.failing ->
     it.fails); Drizzle schema introspected from the current migrated schema; one migration tool from
     here on (drizzle-kit, baselined at the last MikroORM migration so production is not re-migrated);
     the drift test re-pointed at drizzle-kit; a Fastify plugin skeleton with the session hook, view
     rendering and the error page, proven by porting one small route (/healthz, /about).
  3. **Ports with fixes (Phase 2 streams):** calendar (date columns, household time zone, 400s),
     outfits (outfit_slot table, order, archived kept, one transaction), garments and files (text
     columns, ilike, validation, color XSS, clone fields, pixel limit, plain rows for list pages),
     auth and sharing (CSRF, throttling, returnTo, cookie Max-Age, 403 vs 404, change-password).
     Integration tests keep driving HTTP, so they prove each port unchanged; row assertions move from
     `t.em()` to Drizzle.
  4. **Removal:** Nest, MikroORM, class-validator/transformer, reflect-metadata, nestjs-* packages,
     the MikroORM CLI config and snapshot. Then re-measure boot, memory and per-spec time.
- **Migration authority moves to Drizzle in the foundation step (one tool at a time, never two):**
  - `drizzle-kit pull` from a database migrated to the last MikroORM migration gives the schema and a
    0000 baseline migration (the full current schema). New schema changes are drizzle-kit migrations.
  - A boot-time runner (src/db/migrate.ts) replaces MikroORM's migrator: on a database that has
    `mikro_orm_migrations`, it first requires the final MikroORM migration to be recorded (refuse to boot
    otherwise), then records the Drizzle baseline as applied without running it; a fresh database runs
    the baseline directly. Then it runs pending Drizzle migrations. Production's first deploy therefore
    changes nothing but the bookkeeping table.
  - The drift test becomes `drizzle-kit/api` `pushSchema(schema, db)` after boot: `statementsToExecute`
    must be empty. The MikroORM drift test, CLI config and snapshot are deleted; MikroORM entities still
    used by unported code are edited by hand when a Drizzle migration touches their tables.
  - Squash later: when MikroORM is gone and production is past the baseline, the legacy
    `mikro_orm_migrations` check goes too.
- **Scratch database hygiene:** `npm run check` kills the test run when another check fails
  (concurrently --kill-others-on-fail), so afterAll never drops that run's scratch databases; 41 had
  piled up on pgvault-dev by 2026-09-25. Put the creation time in the name and have Vitest's
  globalSetup drop idle scratch databases older than an hour.
- **Background removal on the server:** Phase 4. Benchmark candidate models (the current isnet_quint8,
  newer BiRefNet/RMBG-class models; check licenses) under onnxruntime-node on the NAS CPU; the phone
  uploads a downscaled photo and gets the cutout back. Removes the 44 MB model download per phone and
  onnxruntime-web from the client.
- **Web Push:** Phase 3 instead of deletion. Fix subscription (it reads the httpOnly cookie, so it never
  runs), payload shape, endpoint upsert and 404/410 pruning; decide what it is for (candidate: a morning
  reminder of the outfit planned for today) before building triggers.
- **Templates: typed JSX** (owner, 2026-09-25) replaces Handlebars, per feature inside the same ports
  (a port rewrites that feature's routes, queries and views together, each view typed against its
  model). Build impact is negative: tsconfig `jsx`/`jsxImportSource` (SWC and Vitest honor it); drops
  @fastify/view, hbs, handlebars, the helper registry and the runtime views/ copy (views/assets stays).
  Library: prefer an escape-by-default JSX (Hono's `hono/jsx`, rendered to a string, no Hono server) over
  @kitajs/html, whose text is unescaped unless marked safe and needs its xss-scan linter as a gate;
  confirm with a prototype in the foundation step. The foundation step renders JSX beside Handlebars.

## Phase 2 — Correctness and security

- CSRF: `SameSite=Lax` cookie + Origin check on unsafe methods.
- Throttler actually configured (and real client IP from phase 0).
- `returnTo` accepts same-origin relative paths only; garment colors validated and rendered as text.
- Password change in-app with re-auth; reset PIN hashed, expiring, single-use, attempt-limited (or
  removed with email, see decisions). Cookie `maxAge` units fixed.
- Logout clears the service worker's page caches.
- Calendar: DATE columns, "today" from the client's time zone.
- Outfit membership has one owner: the pivot with a `position` column; `slots` JSON dropped.
  Editing keeps archived garments. Outfit save + schedule in one transaction, idempotent.
- `$ilike` search; `varchar(255)` notes/endpoints -> `text`; UNIQUE on share ids; clone copies all
  fields; sharp `limitInputPixels`.

Found by the Phase 1 test suites (each is an `it.failing` test of the correct behavior, so a fix
turns CI red until its marker is removed):
- Inline validate endpoints (register, update-email, reset-code) return a full page into the form.
- Email change to an address another account uses: 500. A wrong reset PIN redirects as if it worked.
- Garment edit has no server-side validation (empty category saved); malformed dates 500 on garment
  edit, POST /calendar and outfit scheduling.
- Cookie Max-Age 1000x too long (ms passed where seconds expected); failed login answers 201.
- Spring DST week labelled 8, 8, 9... when the server time zone observes DST.
- POST /calendar/:id/delete and /worn 500 without a body.
- Decide: strangers get 403 (leaks existence) vs 404; a VIEW grantee may clone the owner's garments.
- Rate limiting: ThrottlerModule.forRoot() configures no throttler (throttler 6.7 now warns at boot).

Left open by the auth port (2026-09-26): ACCESS_TOKEN_SECRET defaults to `ChangeMe!` (require it);
logout is a GET (make it a POST); update-email does not ask for the current password; unique index on
lower(email); the recovery CLI boots the app context, so it also runs pending migrations.

## Phase 3 — Simplify

Default deletions (dead in production): `lodash`, S3 backend and AWS SDK, `flagged`/`banned`/
`file.mimetype` columns, unused brand query, Cloudflare preconnect, `tailwind.config.js`.
Also: the five non-English languages. Pending decisions: auth-off mode, email/reset.
Then: calendar service split, wardrobe controller de-duplication, one absolute-URL builder,
config defaults in one place, photos under their own `DATA_PATH/photos` folder, log rotation
without ANSI codes, one baseline Postgres migration after the schema settles.

## Phase 4 — Fast

Phone:
- Downscale to 1080 px when the photo is picked (fixes 24 MP Safari failure and iOS PNG cutouts;
  upload 4-16 MB -> 0.2-1.2 MB). Photo-first flow, no debug logging, mask editor on demand,
  no full reload at the end.
- Background removal placement decided by a benchmark of the model on the NAS CPU.
- Service worker: production build (130 KB -> 27 KB), navigation preload, stale-while-revalidate
  pages with a freshness indicator.
- htmx: `HX-Location` instead of `HX-Redirect`; outfit cards, calendar chips and wardrobe switcher
  as swaps; boost into `main` not `body`; smaller history cache; pwa-install and pull-to-refresh
  set up once and only when useful; drop the 250 ms transition; tap feedback.
- Outfit builder: thumbnails instead of 1080 px originals (-518 KiB), one garment per row request.
- Static files precompressed at build (brotli/gzip); hashed model files never revalidated.

Server:
- Keyset pagination with infinite scroll (48 tiles), owner-first composite indexes, drop the 3
  redundant ones.
- List pages read plain rows, not ORM entities (60-70% of busy time today).
- HEIC decode to raw pixels in a worker thread; each image decoded once; faster WebP effort.
- Pool keeps warm connections; `allowGlobalContext: false`; HEIC and S3 not loaded at boot.

Image and deploy:
- Pruned image (456 MB -> ~168 MB compressed), `.dockerignore`, base pinned by digest, non-root,
  tini + `enableShutdownHooks` + `node dist/main`, HEALTHCHECK.
- `deploy.sh update` waits for health and reverts to the previous `sha-` tag on failure; image tag
  as a compose env var; migrations with `lock_timeout` and invalid-index repair; updater every 15 min.

Finish by re-running audit2-measure.md's method and publishing before/after tables.

## Targets

| metric | now | target |
|---|---|---|
| /wardrobe TTFB at 1,500 garments (dev box, +1 ms DB) | 63 ms | < 15 ms |
| /outfits/new Lighthouse mobile LCP | 4.96 s | < 2.5 s |
| Photo upload bytes per garment | 4-16 MB | < 1.2 MB |
| Image size, compressed | 456 MB | ~170 MB |
| Push to production | ~34 min, ungated | gated, ~6 min + <= 15 min |
| Pre-commit | 17-20 s, no hook | 5-6 s, enforced |
| Routes with a behavior test | 28 of 58 | 58 of 58 |

## Decisions

Made by the owner on 2026-09-25:
- **SQLite dropped.** Postgres only; local development and tests use the shared pgvault-dev
  (`../pgvault-dev`, localhost:5432), CI a postgres:17 service. Implemented first, ahead of phase 0's
  commit order, at the owner's request.
- **English only.** The five other languages go in phase 3; whether nestjs-i18n itself stays
  (single-language string catalog) or strings move inline is decided there on cost.
- **Sharing stays, deprioritised.** The owner may share a wardrobe with friends later. Keep the
  feature working and covered by tests; its rebuild around an explicit invite state machine is
  deferred until sharing is actually wanted. Do not delete it in phase 3.
- **Backups are a separate homelab effort**, not part of this program.

- **Login is always required** (2026-09-25): AUTH_ENABLED and the no-login mode go, first thing
  in Phase 2, so CSRF and the owner columns are built for one mode.
- **Email reset goes** (2026-09-25): replaced by an in-app change-password with the current password;
  the PasswordReset table, EmailModule and nodemailer are deleted (which also removes the cascading FK).

Still open:
1. Background removal: browser (with threads, photo-first) or server (benchmark decides).
Defaults unless the owner objects: S3 deleted. Web Push kept (see Platform decisions).
