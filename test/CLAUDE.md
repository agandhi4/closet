# Tests

The tiers and their commands are in the root `CLAUDE.md` (Commands, Test tiers).

- **Tests**: three tiers. Vitest unit (`src/**/*.spec.ts`, and `scripts/**/*.spec.ts` for the tooling's rules; mocks everything, verifies wiring); Vitest integration (`test/integration/`, the real app in-process on a scratch Postgres database per spec file, driven through `app.inject()`, verifies behavior: HTML, headers, rows, files); Playwright e2e (`test/*.spec.ts`, real browser against a built server). Both Vitest tiers are projects of one `vitest.config.ts` (Vite's esbuild transform, JSX settings from `tsconfig.json`; specs import `describe`/`it`/`expect`/`vi` from `'vitest'`, no globals). Integration specs assert rows through `t.db` (Drizzle) and log lines through `t.logs` (what the app really wrote; `captureLogs()` in `test/support/log-capture.ts` for a unit). `recordQueries(work)` (harness) counts the statements and rows a request reads, with their SQL text, for proving a page reads what it shows. Plus autocannon load test (`scripts/load-test.ts`) and Lighthouse CI. Vitest replaced Jest on 2026-09-25, the first step of the platform migration that ended with NestJS's removal on 2026-09-26.

## Layout

```
  support/             scratch-database.ts (integration tier + load test), e2e-session.ts (Playwright signIn),
                       e2e-data.ts (Playwright's garments, outfits, capsules through the app's POSTs),
                       test-server.ts (`npm run start:test`: the build served with a stubbed cutout runner,
                       for Playwright, the load test and Lighthouse),
                       household-today.ts (householdToday: the server's "today" for Playwright),
                       log-capture.ts (LogCapture, captureLogs: the app's log lines as records),
                       weather-stub.ts (Open-Meteo's stand-in on 127.0.0.2: the seed's weather,
                       forecast and archive),
                       schema-drift.ts (drizzle-kit pushSchema), legacy-migrations.ts + legacy-migrations/
                       (the frozen MikroORM tree; builds a MikroORM-era database)
  integration/         Vitest in-process specs + harness.ts (createTestApp: t.inject, t.db, t.logs, t.today; multipart,
                       HTML helpers); authorization-matrix.ts (describeMatrix: the authorization matrix, which
                       authorization-<group>.spec.ts run per route group)
```

## The PWA specs

```
                              # test/pwa.spec.ts (service worker, offline shell, no model requests),
                              # test/stale-pages.spec.ts (stale-while-revalidate tab roots, freshness,
                              # page cache ownership),
                              # test/install-dialog.spec.ts (what the install dialog costs, where it shows) and
                              # test/push-settings.spec.ts (the profile's notification controls and a device's reminders) skip
                              # unless the server was started with PWA_ENABLED=true (+ VAPID keys,
                              # https: SITE_URL). Production config locally, as CI's e2e job runs it:
                              # SITE_URL=https://closet.test PWA_ENABLED=true \
                              #   PUBLIC_VAPID_KEY=.. PRIVATE_VAPID_KEY=.. npm run verify:push
```

## Gotchas

- **Playwright serves whatever is on :3000** (or on `PORT`, which `playwright.config.ts`'s `baseURL`, the spec's `APP_ORIGIN` and the started server all follow: `PORT=3107` runs a worktree's specs beside another's). Its webServer is `npm run start:test` (`test/support/test-server.ts`): the existing build (the npm scripts build first; it imports `dist/`, so a stale or missing build is what runs) served by `serve()` with a stub cutout runner (3 s a photo), so an upload goes pending and its cutout arrives without the model. `reuseExistingServer` is on outside CI, so a running `start:dev`/`start:prod` is tested instead, with the real model on uploads. Stop it before `verify:push`.
- **The authorization matrix is split by route group so Vitest spreads it** (#113): each `authorization-<group>.spec.ts` hands its `ROUTES` to `describeMatrix` (`authorization-matrix.ts`), which boots its own app and fixture. A case compares one statement's md5 per table (and the stored file names) before and after the request, and fetches rows only to explain a difference; a clone's success alone compares every row. A new table a wardrobe request may write joins `TABLES` there, and a new route joins its group's file.
- **Playwright runs two workers in CI** (`playwright.config.ts`), all specs at once against one server and database, so a spec owns its data: its own users, or, for `screenshots.spec.ts` (serial, one worker), personas reset at the start of every attempt (src/seed/CLAUDE.md, CI screenshots).
- **The integration harness configures the app explicitly.** `createTestApp(overrides)` builds `Config` with `loadConfig({ env: { ...BASE_ENV, ...database, DATA_PATH, ...overrides }, envFiles: [] })`: neither the process environment nor `.env.local` reaches a spec, and different overrides in one file are fine. Its logger writes JSON lines into `t.logs` (LOG_LEVEL `debug`, nothing on the console); `{ appLog: true }` gives the real stdout + `app.log` outputs instead (file-route.spec.ts reads app.log). Vitest runs every file in its own child process (the default `forks` pool with `isolate`), which keeps one file's app, rate-limit counters and mocks out of the next: never set `isolate: false` or `pool: 'threads'` on the integration project.
- **The integration harness is signed in by default.** `createTestApp` registers `owner@example.com` at boot and `t.inject` sends that session (`t.owner.cookie`) unless the request has its own `cookie` header or passes `anonymous: true`. A test about signed-out behavior must say `anonymous: true`; one that forgets asserts on the owner's view.
- **`test/support/legacy-migrations.ts` loads the MikroORM migrations through `dynamicImportProvider`.** MikroORM's default is an `import()` inside `node_modules`, which Vitest does not intercept: Node then loads the migration `.ts` itself with type stripping, outside Vitest's resolution. The provider's `import()` sits in our file, so Vitest's module runner handles it. The frozen migrations import nothing from `src/` (Migration20260925182919 keeps its own copy of the colour list: its ordinals are positions in the enum as it was).
- **Vitest runs a function returned from `beforeEach`/`beforeAll` as that hook's cleanup.** `beforeEach(() => mock.mockReset())` returns the mock, so Vitest calls it after every test; with `mockRejectedValue` set, the test fails with the mock's rejection. Brace hook bodies that return anything. Jest ignored the return value.
- **`vi.mock` factories return the module namespace.** Mocking a CommonJS default export is `vi.mock('heic-decode', () => ({ default: { all: vi.fn() } }))`, and `vi.mocked(heicDecode.all)` types it; Jest's `() => jest.fn()` shape throws ("is not returning an object"). `vi.mock` is hoisted like `jest.mock`.
- **Vitest is pinned to `~4.0`.** Vitest 4.1 depends on Vite 8, whose optional peer chain (`@vitejs/devtools` back to `vitest`) crashes npm 10's resolver with "Cannot read properties of null (reading 'edgesOut')", and npm 11 lockfiles break the Docker build (see the lockfile gotcha). Bump only when `npx -y npm@10 install -D vitest@<new>` resolves, and prove the lockfile with `npm ci --dry-run` on npm 10.
- **Scratch databases are named with their creation time** (`closet_it_<base36 seconds>_<hex>`). A killed test run (`npm run check` stops the tests when another check fails) never drops its databases; the integration project's globalSetup (`test/support/sweep-scratch-databases.ts`) drops idle ones older than an hour, never with FORCE, and leaves names it cannot date.
- **Vitest does not type-check.** It compiles with esbuild, which strips types; `npm run typecheck` (the root `tsconfig.json`: `src/`, `test/`, `scripts/`, the configs; no test globals, so a helper that calls `expect` without importing it fails here) and `npm run build` (`tsc -p tsconfig.build.json`, `src/` only) do. The service worker has its own `views/assets/tsconfig.json` (WebWorker lib, strict) because it runs in a worker scope. It was 790 errors until 2026-09-25, one of them a live 500 (a misspelled MikroORM exception import is `undefined` at runtime, so `instanceof` threw).
- **`locator.click()` can move a scroll-snap strip.** Its actionability scroll-into-view (retried with other alignments when the page is slow) scrolls Styling's strip, which snaps onto a neighbour: the tap lands on one garment while the row chooses another (1 in 3 runs under CPU load, #105). To tap a strip item as a finger does, wait until it sits centred and `page.mouse.click` its middle (`tapCentredItem`, `test/back-navigation.spec.ts`).
