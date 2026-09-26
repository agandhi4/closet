# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

#### Added

- Change password (`/auth/change-password`, linked from the profile): needs the current password (400 with an error when it is wrong), applies the registration password rules, signs out every other session and keeps the current one
- Nightly storage reconciliation (`MAINTENANCE_ENABLED`, `@nestjs/schedule`) and `npm run maintenance:reconcile [-- --dry-run]`: orphaned photo sets and unreferenced `file` rows older than a day are deleted, rows whose original is missing are reported
- HEIC/HEIF uploads: decoded server-side with heic-convert (capped by `MAX_HEIC_BYTES`), accepted by the photo inputs; browsers that cannot decode HEIC skip the client-side cutout and upload the original

#### Fixed

- Dependency security: sharp 0.35.4 (libvips 8.18.6, libheif 1.23.2 advisories; this app decodes untrusted uploads), @fastify/static 10.1.4 (path traversal and route-guard bypass), Nest 11.2.6. `npm audit --omit=dev`: 9 high to 0 high; 6 moderate remain in fastify (pinned by Nest 11) and the migration CLI
- Accepting a wardrobe invite that races a duplicate grant now answers 400 instead of 500 (the unique-violation check referenced a MikroORM export that does not exist)
- `/file/app.log` (and any other non-photo file under `DATA_PATH`) was served to anyone; the route now serves only photo names. Request logs no longer record `cookie`, `authorization` or `set-cookie` headers, and static requests and the heartbeat are no longer logged
- Uploading a photo together with its background-removed cutout failed with 500 whenever the cutout was a realistic size: the thumbnail read the cutout while it was still being written. Local storage writes are now atomic, and each upload builds its thumbnail once
- An undecodable photo upload (junk bytes sent as HEIC or JPEG) no longer crashes the server with an unhandled rejection; it is a 400 and the app keeps serving
- Deleting an account now removes the user's photos from storage; the confirmation credentials must belong to the account being deleted, and a refused deletion answers 401 (400 for a malformed body) instead of 201
- Choosing a photo the browser cannot decode no longer leaves the upload button disabled
- A missing cutout no longer logs a warning on every garment delete
- Nest logger output is flushed once the pino logger is installed, so an app that is only initialised (the integration harness) no longer buffers every log line forever

#### Performance

- Photos are stored as versioned variants (original and cutout at q90, a 400px thumbnail) served immutable for a year under `?v=<File.version>`; grids render thumbnails with lazy loading and dimensions. A 150-garment grid went from 28.6 MB uncached to 1.3 MB, zero once cached
- The session is resolved once per request and not at all for static assets and images (was up to three JWT verifications and user queries per request, one per image)
- Static scripts and styles carry a build cache key and are served immutable; `sw.js` and `manifest.json` are `no-cache`
- Service worker: cache-first app shell, network-first pages and htmx fragments with a 3 s timeout, cached garment images for offline reads, no more 42 MB model download on every garment page
- The wardrobe answers htmx requests with a fragment instead of the full page; filter dropdowns come from `SELECT DISTINCT` instead of a second full scan
- Indexes on every relation and lookup column, backfilled on Postgres with `CREATE INDEX CONCURRENTLY`
- Photo and row writes are one transaction with compensation; deleting a garment removes its files and file row

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

- Password reset by email: `/auth/reset`, `/auth/reset-code` and their validation route, the `password_reset` table and `user.password_reset_id` (whose `ON DELETE CASCADE` let a deleted reset row take its user with it), `src/email/`, the `EMAIL_*` settings and the `nodemailer` and `nodemailer-mailgun-transport` dependencies
- `AUTH_ENABLED` and the anonymous mode it switched on (owner-less garments, outfits and calendar entries visible to every visitor). A leftover `AUTH_ENABLED` in the environment is ignored
- SQLite support: `DATABASE_TYPE`, the `@mikro-orm/better-sqlite` driver, the SQLite migration tree and its CLI config. Postgres (13+) is required; `DATABASE_HOST`, `DATABASE_SCHEMA`, `DATABASE_USER` and `DATABASE_PASS` no longer have defaults. Tests and the load test run on scratch Postgres databases (`TEST_DATABASE_URL`, default pgvault-dev on `localhost:5432`)
- The boilerplate SSE chat demo (`/chat`, `/sse`, `/message`) and the `htmx-ext-sse` dependency
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
