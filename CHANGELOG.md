# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

#### Security

- Cross-site request forgery: every POST, PUT, PATCH and DELETE must come from this site (its `Origin`, or `Referer` without one, names the address it was sent to or `SITE_URL`), else 403; the session cookie is `SameSite=Lax`. Emails, passwords, shares and garments could be changed from any other site before
- Login and registration are rate limited (5 a minute per address) and changing the password or deleting the account (5 a minute per user): `@nestjs/throttler` had never limited anything. The client address comes from `TRUSTED_PROXIES`, which must include the reverse proxy's address
- `?returnTo=` on the outfit form accepts only same-site paths: a `javascript:` value ran script from the Back link
- IDs no longer reveal whose data exists: another user's garment, outfit, calendar entry or share, and a wardrobe shared with someone else, answer 404 instead of 403. A grantee who can see a garment but not change it still gets 403
- Invite tokens no longer reach the request log (the route pattern is logged); invite links are built from the trusted host, not the raw Host header
- Signing out clears the browser's cache (`Clear-Site-Data`) and the app's cached pages, so the next person on the device cannot read the last user's wardrobe offline
- Canonical and Open Graph URLs no longer trust `X-Forwarded-Host`/`-Proto` from clients that are not trusted proxies

#### Added

- Change password (`/auth/change-password`, linked from the profile): needs the current password (400 with an error when it is wrong), applies the registration password rules, signs out every other session and keeps the current one
- Nightly storage reconciliation (`MAINTENANCE_ENABLED`, `@nestjs/schedule`) and `npm run maintenance:reconcile [-- --dry-run]`: orphaned photo sets and unreferenced `file` rows older than a day are deleted, rows whose original is missing are reported
- `npm run user:set-password -- <email>`: sets a locked-out user's password from the server (read without echo, or from piped stdin), with the registration rules, signing out every session of that account
- `APP_TIMEZONE` (IANA name, default `America/New_York`): the household's time zone, which decides what "today" is on the calendar and which week opens by default
- HEIC/HEIF uploads: decoded server-side with heic-convert (capped by `MAX_HEIC_BYTES`), accepted by the photo inputs; browsers that cannot decode HEIC skip the client-side cutout and upload the original
- Notifications on the profile page (with `PWA_ENABLED`): "Enable notifications on this device" asks for permission only on that tap, the page shows this device's state (on, off, blocked, unsupported, or "add to Home Screen first" in iOS Safari), and "Send a test notification" sends to all of the user's devices and says how many it reached. Signing out drops the device's subscription. Nothing sends notifications on its own yet

#### Fixed

- Account forms (login, registration, email, password, deletion) submit as real form posts, so browsers offer to save the password: a registration's browser-generated password was never saved and the account was lost. A failed login shows "Incorrect email or password" once with a 401 (it swapped a whole second page into the page and said "Error"); validation failures are 400 with the messages under the fields; deleting the account with wrong credentials now shows the error
- The inline checks while registering or changing the email answer with the messages only, instead of a whole page nested into the form; they no longer replace the fields being typed in or dim the submit button
- Emails are case-insensitive: stored lower case and matched regardless of case at login, registration and email change. Changing the email to one another account uses is a field error instead of a 500
- The session cookie's `Max-Age` was 1000 times the intended 365 days (milliseconds where seconds are expected)
- Calendar: every evening after UTC midnight (19:00 or 20:00 in New York) the calendar highlighted tomorrow and on Saturday evening opened next week; "today" now comes from `APP_TIMEZONE`. Days are plain dates end to end, so a server zone with DST can no longer mislabel a week (the spring-forward week read 8, 8, 9, ...)
- Calendar: a malformed date, outfit id or week posted to `/calendar` answers 400 with the error page instead of 500, and a malformed `?week=` or `?calMonth=` opens the current week; deleting or marking an entry worn without a request body no longer 500s
- Scheduling an outfit is idempotent: the same outfit on the same day twice (a double tap, or saving the outfit form again) keeps one calendar entry instead of adding a duplicate
- Outfits show their garments in the order they were built, on the list, the outfit page and the calendar (they came back in whatever order Postgres chose)
- Editing an outfit keeps a garment that has since been archived: the form shows it, marked "Archived", and saving keeps it. Every save dropped it before
- Saving an outfit and adding it to the calendar is one transaction: a malformed date is a 400 before anything is written (it saved the outfit and then failed with a 500), and a failure part-way leaves nothing behind. A name or notes over 255 characters, or a row without its garment field, is a 400 instead of a 500
- The outfit form ignores garment ids that are not the user's without keeping them anywhere (the saved rows used to keep them)
- Dependency security: sharp 0.35.4 (libvips 8.18.6, libheif 1.23.2 advisories; this app decodes untrusted uploads), @fastify/static 10.1.4 (path traversal and route-guard bypass), Nest 11.2.6. `npm audit --omit=dev`: 9 high to 0 high; 6 moderate remain in fastify (pinned by Nest 11) and the migration CLI
- Accepting a wardrobe invite that races a duplicate grant now answers 400 instead of 500 (the unique-violation check referenced a MikroORM export that does not exist)
- `/file/app.log` (and any other non-photo file under `DATA_PATH`) was served to anyone; the route now serves only photo names. Request logs no longer record `cookie`, `authorization` or `set-cookie` headers, and static requests and the heartbeat are no longer logged
- Uploading a photo together with its background-removed cutout failed with 500 whenever the cutout was a realistic size: the thumbnail read the cutout while it was still being written. Local storage writes are now atomic, and each upload builds its thumbnail once
- An undecodable photo upload (junk bytes sent as HEIC or JPEG) no longer crashes the server with an unhandled rejection; it is a 400 and the app keeps serving
- Deleting an account now removes the user's photos from storage; the confirmation credentials must belong to the account being deleted, and a refused deletion answers 401 (400 for a malformed body) instead of 201
- Choosing a photo the browser cannot decode no longer leaves the upload button disabled
- A missing cutout no longer logs a warning on every garment delete
- Nest logger output is flushed once the pino logger is installed, so an app that is only initialised (the integration harness) no longer buffers every log line forever
- Web Push never worked: the page looked for the httpOnly session cookie before subscribing, so it never did; the service worker read a payload shape the server did not send; re-subscribing with renewed keys, or the same browser under another account, was a 500 (unique endpoint); endpoints over 255 characters (Firefox) failed; a device its push service reported gone was never removed. Subscriptions are now stored by endpoint (upserted), gone devices (404/410) are removed on the next send, and a malformed subscription is a 400

#### Performance

- Photos are stored as versioned variants (original and cutout at q90, a 400px thumbnail) served immutable for a year under `?v=<File.version>`; grids render thumbnails with lazy loading and dimensions. A 150-garment grid went from 28.6 MB uncached to 1.3 MB, zero once cached
- The session is resolved once per request and not at all for static assets and images (was up to three JWT verifications and user queries per request, one per image)
- Static scripts and styles carry a build cache key and are served immutable; `sw.js` and `manifest.json` are `no-cache`
- Service worker: cache-first app shell, network-first pages and htmx fragments with a 3 s timeout, cached garment images for offline reads, no more 42 MB model download on every garment page
- The wardrobe answers htmx requests with a fragment instead of the full page; filter dropdowns come from `SELECT DISTINCT` instead of a second full scan
- Indexes on every relation and lookup column, backfilled on Postgres with `CREATE INDEX CONCURRENTLY`
- Photo and row writes are one transaction with compensation; deleting a garment removes its files and file row
- Outfit builder: `/outfits/new` reads one garment per category plus counts instead of the whole wardrobe, each prev/next swap reads one garment instead of the whole category, and rows show the 400px thumbnail instead of the 1080px cutout (which the detail dialog loads only when opened). The list and outfit pages read plain rows in one statement

#### Fixed (data and security)

- `garment.color` had become a smallint on Postgres, so any garment saved with a color failed there; the column is a validated string again
- With auth disabled, a request carrying `?ownerId` could write into that owner's wardrobe; an own garment addressed under a foreign `?ownerId` was served. Both are 403
- Handlebars partials were registered asynchronously and never awaited, so the first render after boot could fail
- The invite landing page redirected the anonymous recipient it exists for
- The runtime migrator wrote schema snapshot files into `src/` and `dist/` on every boot

#### Developer experience

- In-process integration tier (`npm run test:int`) booting the real app with an in-memory SQLite or a throwaway Postgres; runs on both drivers in CI. `npm run precommit` is the fast chain (about 16 s); `npm run precommit:full` keeps Playwright, the load test and Lighthouse
- `TRUSTED_PROXIES`, `LOG_LEVEL`, `/healthz`, offline banner and update toast, one `resolveAccess` for wardrobe permissions

#### Changed

- Web Push is served by the plain-Fastify web layer at `/push/*` (`vapid-public-key`, `subscribe`, `unsubscribe`, `test`) instead of `/notification/*`, only when `PWA_ENABLED`. `user_device` keeps the subscription keys as columns (`key_p256dh`, `key_auth`), the endpoint and user agent as text, and gains `created_at`/`updated_at`; the migration deletes rows without usable keys (the browser sends its subscription again). The VAPID keys and `SITE_URL` (the https contact) are checked at boot
- Outfits (`/outfits`, the builder, its row fragment and the writes) are served by the plain-Fastify web layer with Drizzle queries and typed JSX views; URLs, form fields and htmx targets are unchanged. The list is newest first
- What an outfit wears is one `outfit_slot` table (position, category, optional garment; deleting a garment empties its slot) instead of the `outfit.slots` JSON and the `outfit_garments` pivot, which disagreed. The migration copies the JSON rows in order, keeping a garment only if it still exists and belongs to the outfit's owner, builds slots from the pivot for outfits that had none, and refuses to run if any outfit's garments differ between the two stores
- The calendar (`/calendar` and its writes) is served by the plain-Fastify web layer with Drizzle queries and typed JSX views; URLs, form fields, htmx targets and responses are unchanged. Web-layer input is validated by Fastify's JSON schemas (TypeBox)
- `outfit_calendar.date` (timestamptz at UTC midnight) is now `day date`; the migration refuses to run if any value is not UTC midnight, removes duplicate schedules (keeping a worn one), drops the never-written `notes` column, and replaces the date and owner indexes with one unique `(owner_id, day, outfit_id)` index
- `/`, `/about`, `/offline.html`, `/manifest.json`, `/healthz` and `/.well-known/*` are served by the plain-Fastify web layer (`src/web/`, typed JSX views through `hono/jsx`) instead of Nest and Handlebars, the first routes of the platform migration. Statuses, headers and cache policy are unchanged; the About and offline pages render the same shell. The session gate for these routes shares its decision with `SessionGuard`
- Migrations run through Drizzle: `src/db/schema.ts` is the schema and `drizzle/` the migrations, applied at boot under a Postgres advisory lock (server and `maintenance:reconcile` never migrate at once). An existing database must have applied the last MikroORM migration (`Migration20260926021506`); its first boot records the Drizzle baseline without running it and changes nothing else. MikroORM still serves queries; its migrator, CLI config and snapshot are gone
- Login is always required. One global `SessionGuard` replaces `ConditionalAuthGuard`, `RequireSessionGuard` and `AuthGuard`: every route needs a session unless it is `@Public()` (login, registration, logout, `/about`, `/offline.html`, `/healthz`, `/manifest.json`, `/.well-known/*`, `/share`, the invite landing page, `/file/**`). Signed out, a page navigation redirects to `/auth/login` and an htmx fragment or fetch answers 401 with `HX-Redirect: /auth/login`
- Every garment, outfit, calendar entry and photo row has an owner: the columns are `NOT NULL`, and the migration deletes owner-less rows first (only the removed anonymous mode could reach them; their photo files go with the next storage reconciliation)
- Rebrand to Closet, a private household fork of Libre Closet
- Removed Lazztech branding, marketing content, and the privacy and terms pages
- `/` now redirects to the wardrobe; there is no landing page
- App name and icon are driven by `APP_NAME` and `ICON_NAME` config
- VAPID keys are required when `PWA_ENABLED=true`; no committed defaults
- Share-link preview watermark is opt-in via `WATERMARK_ENABLED` (default false)
- New icon, generated by `npm run generate:icons`
- Logged-out page hits redirect through `RedirectToLoginException`; no more "Forbidden resource" warnings per anonymous request
- Docker runtime stage installs production dependencies only (`npm ci --omit=dev`)
- Load test measures `/wardrobe` (page and fragment), `/outfits/new` and a seeded thumbnail; `LOAD_TEST_DURATION` sets the seconds per target

#### Removed

- German, Spanish, French, Italian and Russian strings, the Accept-Language resolver and the unused generated i18n types: the app is English only
- Password reset by email: `/auth/reset`, `/auth/reset-code` and their validation route, the `password_reset` table and `user.password_reset_id` (whose `ON DELETE CASCADE` let a deleted reset row take its user with it), `src/email/`, the `EMAIL_*` settings and the `nodemailer` and `nodemailer-mailgun-transport` dependencies
- `AUTH_ENABLED` and the anonymous mode it switched on (owner-less garments, outfits and calendar entries visible to every visitor). A leftover `AUTH_ENABLED` in the environment is ignored
- SQLite support: `DATABASE_TYPE`, the `@mikro-orm/better-sqlite` driver, the SQLite migration tree and its CLI config. Postgres (13+) is required; `DATABASE_HOST`, `DATABASE_SCHEMA`, `DATABASE_USER` and `DATABASE_PASS` no longer have defaults. Tests and the load test run on scratch Postgres databases (`TEST_DATABASE_URL`, default pgvault-dev on `localhost:5432`)
- The boilerplate SSE chat demo (`/chat`, `/sse`, `/message`) and the `htmx-ext-sse` dependency
- The Nest notification module (`/notification/*`), its `UserDevice` entity, and the `lodash` dependency it alone used
- The generic file gallery (`/file/files`, `/file/upload`); `/file/*` now only serves image variants

## 0.5.1 - 2026-09-10

#### Added

- Add explicit save confirmation to garment upload flow
- Camera option for garment photo upload

#### Fixed

- Pre-select first garment in builder and fix Handlebars rendering

## 0.5.0 - 2026-06-26

#### Added

- Garment color combination support
- Garment washing details
- Garment acquisition date
- Garment archival
- Garment cloning

#### Fixed

- Visual bug on outfit builder

## 0.4.1 - 2026-06-15

#### Fixed

- Fix DISABLE_REGISTRATION logic

## 0.4.0 - 2026-06-13

#### Added

- Wardrobe sharing from one user to another with either view only or edit permissions

## [0.3.2] - 2026-06-09

#### Added

- Background removal toggle for garment photo uploads

## [0.3.1] - 2026-05-26

#### Changed

- Server HttpAdapter to Fastify, resulting in nearly a 2x throughput increase and almost half the latency.

## [0.3.0] - 2026-05-21

#### Added

- Garment image background touch up tool

## [0.2.5] - 2026-05-1

#### Added

- Option to disable register functionality

## [0.2.4] - 2026-04-28

#### Fixed

- Fix garment photo upload cropping

## [0.2.3] - 2026-04-20

#### Added

- Russian language support

## [0.2.2] - 2026-04-17

#### Changed

- Garment and Outfit names now optional

## [0.2.1] - 2026-04-15

#### Fixed

- fix empty outfit click area

## [0.2.0] - 2026-04-10

#### Added

- Clueless inspired outfit builder
- Outfit Scheduling
- Image background removal (Client-side and Server-side)
- Customizable categories

## [0.1.9] - 2026-03-19

#### Fixed

- Rely on http cache layer for images from the file endpoint rather than the service worker
- Extended login validity and added token fingerprint for invalidation on password change

#### Changed

- Change garments query to order by descending order to show new items at the top
- Adjusted garment list sizing on mobile

## [0.1.8] - 2026-03-13

#### Fixed

- Safe area inset for search bar
- S3 file service streaming object handling and config

#### Added

- French, German, and Spanish language support

## [0.1.7] - 2026-03-07

#### Added

- Italian language support

## [0.1.6] - 2026-03-06

#### Added

- Garment search and filter

## [0.1.5] - 2026-03-05

#### Fixed

- Added missing postgresql migration

## [0.1.4] - 2026-03-03

#### Fixed

- Fixed service worker update causing black screen

## [0.1.3] - 2026-03-03

#### Added

- Added garment "lingerie" category

## [0.1.2] - 2026-03-02

#### Fixed

- Fixed images rotate 90 degrees when uploaded

## [0.1.1] - 2026-02-26

### Fixed

- Bug fix for sharing outfits or wardrobes
- Validation to prevent user from submitting image before one is selected

### Changed

- Button label from "copy text" to "share" for clarity

## [0.1.0] - 2026-02-25

### Added

- MVP functionality
