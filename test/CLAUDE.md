# Tests

The tiers and their commands are in the root `CLAUDE.md` (Commands, Test tiers).

- **Tests**: three tiers. Vitest unit (`src/**/*.spec.ts`, and `scripts/**/*.spec.ts` for the tooling's rules; mocks everything, verifies wiring); Vitest integration (`test/integration/`, the real app in-process on a scratch Postgres database per spec file, driven through `app.inject()`, verifies behavior: HTML, headers, rows, files); Playwright e2e (`test/*.spec.ts`, real browser against a built server). Both Vitest tiers are projects of one `vitest.config.ts` (Vite's esbuild transform, JSX settings from `tsconfig.json`; specs import `describe`/`it`/`expect`/`vi` from `'vitest'`, no globals). Integration specs assert rows through `t.db` (Drizzle) and log lines through `t.logs` (what the app really wrote; `captureLogs()` in `test/support/log-capture.ts` for a unit). `recordQueries(work)` (harness, over `test/support/query-recorder.ts`) counts the statements and rows a request reads, with their SQL text, for proving a page reads what it shows. Plus the page audit (`npm run audit:pages`, `scripts/audit/`: every page and action timed and counted as the demo persona against `docs/perf/`'s baseline; `docs/perf/README.md`) and Lighthouse CI. Vitest replaced Jest on 2026-09-25, the first step of the platform migration that ended with NestJS's removal on 2026-09-26.

## Layout

```
  support/             scratch-database.ts (integration tier + page audit), e2e-session.ts (Playwright signIn),
                       e2e-data.ts (Playwright's garments, outfits, capsules through the app's POSTs),
                       test-server.ts (`npm run start:test`: the build served with a stubbed cutout runner,
                       for Playwright and Lighthouse), cutout-stub.ts + cutout-hold.ts (that runner, and
                       the `cutouts` fixture that holds an owner's cutouts pending),
                       query-recorder.ts (recordStatements: every SQL statement this process sends
                       while a callback runs, with rows, start and time; recordQueries and the page audit),
                       multipart.ts, pwa-env.ts (PWA_ENV: the PWA's config with a throwaway VAPID pair),
                       household-today.ts (householdToday: the server's "today" for Playwright),
                       log-capture.ts (LogCapture, captureLogs: the app's log lines as records),
                       weather-stub.ts (Open-Meteo's stand-in on 127.0.0.2: the seed's weather,
                       forecast and archive),
                       jmap-stub.ts (Fastmail's JMAP stand-in on 127.0.0.2 as `jmap.test`: session, inbox
                       query, Email/get; createTestApp's `orderMail`, required with ORDER_MAIL_JMAP_TOKEN;
                       test-server.ts starts it when the token is set),
                       order-mail-shop.ts (the forwarded order email and the shop its links reach:
                       order-mail.spec.ts and the page audit),
                       sentry-stub.ts (Bugsink's stand-in: a local DSN the real Sentry transport posts to,
                       on a free port, or Playwright's SENTRY_STUB_PORT; recordErrors, an in-memory
                       ErrorTracker for unit specs),
                       page-errors.ts (pageErrors: what a spec asserts went wrong in the page),
                       webkit-limits.ts (why a spec skips in the Safari projects),
                       static-assets-setup.ts (globalSetup: public/modules/ and the precompressed
                       variants, as the build lays them out),
                       schema-drift.ts (drizzle-kit pushSchema), legacy-migrations.ts + legacy-migrations/
                       (the frozen MikroORM tree; builds a MikroORM-era database)
  integration/         Vitest in-process specs + harness.ts (createTestApp: t.inject, t.db, t.logs, t.today; multipart,
                       HTML helpers); authorization-matrix.ts (describeMatrix: the authorization matrix, which
                       authorization-<group>.spec.ts run per route group), authorization-coverage.spec.ts
                       (every id route is in the matrix or exempt, #182)
```

## The PWA specs

```
                              # test/pwa.spec.ts (service worker, offline shell, no model requests),
                              # test/stale-pages.spec.ts (stale-while-revalidate tab roots, freshness,
                              # page cache ownership), test/image-cache-privacy.spec.ts (the image
                              # cache and selfies across sessions),
                              # test/install-dialog.spec.ts (what the install dialog costs, where it shows) and
                              # test/push-settings.spec.ts (the profile's notification controls and a device's reminders) skip
                              # unless the server was started with PWA_ENABLED=true (+ VAPID keys,
                              # https: SITE_URL). Production config locally, as CI's e2e job runs it:
                              # SITE_URL=https://closet.test PWA_ENABLED=true \
                              #   PUBLIC_VAPID_KEY=.. PRIVATE_VAPID_KEY=.. npm run verify:push
```

## Gotchas

- **The integration tier's harness, scratch databases and authorization matrix** have their own gotchas: `docs/testing-integration.md` (how createTestApp configures and signs in, how scratch databases are dated and swept, how the matrix and its coverage check work). Read it before changing `test/integration/harness.ts`, `test/support/scratch-database.ts` or an `authorization-*.spec.ts`.
- **Playwright serves whatever is on :3000** (or on `PORT`, which `playwright.config.ts`'s `baseURL`, the spec's `APP_ORIGIN` and the started server all follow: `PORT=3107` runs a worktree's specs beside another's). Its webServer is `npm run start:test` (`test/support/test-server.ts`): the existing build (the npm scripts build first; it imports `dist/`, so a stale or missing build is what runs) served by `serve()` with a stub cutout runner (`cutout-stub.ts`), so an upload goes pending and its cutout arrives without the model. `reuseExistingServer` is on outside CI, so a running `start:dev`/`start:prod` is tested instead, with the real model on uploads. Stop it before `verify:push`.
- **The stub cutout answers at once; a spec that shows a cutout pending holds it** (`cutouts.hold(email)`, `cutout-hold.ts`, #230), and a spec that needs the cutout waits for the page's `?v=2`: `docs/testing-cutouts.md`.
- **The Safari projects (`webkit`, `Mobile Safari`) run nightly, not on PRs** (#179). A spec Playwright's WebKit cannot run skips with a reason from `webkit-limits.ts`, never on `browserName !== 'chromium'`; page errors go through `pageErrors(page)`, which drops a WebKit line that is no error. Running WebKit on linux-box and reading a failure: `docs/testing-webkit.md`.
- **Playwright runs two workers in CI** (`playwright.config.ts`), all specs at once against one server and database, so a spec owns its data: its own users, or, for `screenshots.spec.ts` (serial, one worker), personas reset at the start of every attempt (src/seed/CLAUDE.md, CI screenshots).
- **Playwright's server runs with `METRICS_ENABLED=true`** unless the environment says otherwise (`playwright.config.ts`), as production does: every signed-in page loads `public/js/vitals.js` and beacons to `POST /metrics/vitals`, and `test/metrics.spec.ts` reads `/metrics` (it skips against a server without it). A spec counting a page's requests sees the script and, a few seconds in, its beacon.
- **Playwright's server runs with error tracking on** (`playwright.config.ts` sets `SENTRY_DSN` unless the environment does), as production does, so every signed-in page loads `public/js/errors.js`. The DSN is `SENTRY_STUB_PORT` (`e2e-session.ts`: `PORT` + 10000), where only `test/client-errors.spec.ts` listens, while it runs; other events fail to send, logged as `Could not send an event to Bugsink` and dropped. That spec runs in the `chromium` project only, since one listener fits a fixed port. It counts the beacons in the browser, because the server's Sentry client dedupes an event identical to the one before it, and it waits for `htmx:afterSettle` before throwing on a page it navigated to: until then errors.js still counts against the previous page view.
- **Playwright cannot subscribe to push.** Its contexts are incognito, where Chromium refuses `pushManager.subscribe()` (AbortError, "permission denied") whatever the permission. A persistent context does subscribe, through Google's push service on the internet and at a `*.google.com` endpoint the server's push-host list refuses, so no spec uses one. `push-settings.spec.ts` drives the real PushManager as far as it goes (no subscription, subscribe refused: the error state) and `push-stub.ts` stands in beyond that.
- **`npm run test:cov` is the gate's test job and fails below `coverage.thresholds`** (`vitest.config.ts`, #183). The thresholds are a ratchet about a point under the suite's figures, not a target. A run of a few files fails them, so use `npx vitest run <files>` or `test:all` while working. When the totals have climbed, raise the thresholds. Never lower them to get a change through.
- **Playwright's server runs with the order mail on** (`playwright.config.ts` sets `ORDER_MAIL_*` unless the environment does; #25) against `jmap-stub.ts`'s empty inbox, never Fastmail. Its owner is the fixed `ORDER_REVIEW_OWNER` (`signInAs`, `e2e-session.ts`: registers, or signs in on a reused database); `test/order-review.spec.ts` seeds `order_item` rows straight into the server's database (`loadConfig()`'s, as `householdToday` reads it) and asserts only on its own run's items, since every test shares that account.
- **`test/support/legacy-migrations.ts` loads the MikroORM migrations through `dynamicImportProvider`.** MikroORM's default is an `import()` inside `node_modules`, which Vitest does not intercept: Node then loads the migration `.ts` itself with type stripping, outside Vitest's resolution. The provider's `import()` sits in our file, so Vitest's module runner handles it. The frozen migrations import nothing from `src/` (Migration20260925182919 keeps its own copy of the colour list: its ordinals are positions in the enum as it was).
- **Vitest runs a function returned from `beforeEach`/`beforeAll` as that hook's cleanup.** `beforeEach(() => mock.mockReset())` returns the mock, so Vitest calls it after every test; with `mockRejectedValue` set, the test fails with the mock's rejection. Brace hook bodies that return anything. Jest ignored the return value.
- **`vi.mock` factories return the module namespace.** Mocking a CommonJS default export is `vi.mock('heic-decode', () => ({ default: { all: vi.fn() } }))`, and `vi.mocked(heicDecode.all)` types it; Jest's `() => jest.fn()` shape throws ("is not returning an object"). `vi.mock` is hoisted like `jest.mock`.
- **Vitest is pinned to `~4.0`.** Vitest 4.1 depends on Vite 8, whose optional peer chain (`@vitejs/devtools` back to `vitest`) crashes npm 10's resolver with "Cannot read properties of null (reading 'edgesOut')", and npm 11 lockfiles break the Docker build (see the lockfile gotcha). Bump only when `npx -y npm@10 install -D vitest@<new>` resolves, and prove the lockfile with `npm ci --dry-run` on npm 10.
- **Nothing in Vitest boots the image or `main.ts`**, so line coverage leaves out `src/main.ts`, `src/server.ts`, `src/**/*.cli.ts` and `src/cutout/child.ts` (`vitest.config.ts`). `scripts/smoke-image.sh` is their test: CI boots the built image with it before every publish, and the nightly runs it with the real model plus `cutout-model.spec.ts` (`docs/deployment.md`, CI and publishing). A change to boot, shutdown or the Dockerfile is proved by running it locally against a throwaway pgvault-dev database; the page it checks is `/auth/login`, so a login-page change that drops `<title>…Closet</title>`, the boosted `<body>` or the password field fails it.
- **Vitest does not type-check.** It compiles with esbuild, which strips types; `npm run typecheck` (the root `tsconfig.json`: `src/`, `test/`, `scripts/`, the configs; no test globals, so a helper that calls `expect` without importing it fails here) and `npm run build` (`tsc -p tsconfig.build.json`, `src/` only) do. The service worker has its own `views/assets/tsconfig.json` (WebWorker lib, strict) because it runs in a worker scope. It was 790 errors until 2026-09-25, one of them a live 500 (a misspelled MikroORM exception import is `undefined` at runtime, so `instanceof` threw).
- **`locator.click()` can move a scroll-snap strip.** Its actionability scroll-into-view (retried with other alignments when the page is slow) scrolls Styling's strip, which snaps onto a neighbour: the tap lands on one garment while the row chooses another (1 in 3 runs under CPU load, #105). To tap a strip item as a finger does, wait until it sits centred and `page.mouse.click` its middle (`tapCentredItem`, `test/back-navigation.spec.ts`).
