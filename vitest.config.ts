import { defineConfig } from 'vitest/config';

// Two tiers, one run (`npm run test:all`, the pre-commit hook): one worker
// pool, one coverage report. `npm test` selects the unit projects (`unit*`),
// `npm run test:int` the integration project.
export default defineConfig({
  // TypeScript and TSX go through Vite's own esbuild transform, which takes
  // jsx/jsxImportSource (hono/jsx) from tsconfig.json.
  test: {
    // Global, inherited by every project (extends: true). The budget covers
    // an integration spec's beforeAll: scratch database, migrations and app
    // boot, slower on CI's 2-core runner.
    testTimeout: 30000,
    hookTimeout: 30000,
    maxWorkers: '50%',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.spec.{ts,tsx}', 'src/main.ts'],
      reportsDirectory: 'coverage',
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.spec.{ts,tsx}'],
          exclude: ['src/web/calendar/**/*.spec.{ts,tsx}'],
        },
      },
      {
        // The calendar's date logic in a DST zone: UTC (CI's zone) hides
        // every local-time mistake, and the calendar must not depend on the
        // process's zone at all (APP_TIMEZONE decides "today"). `env` is
        // applied to the worker's real process.env before the spec is
        // imported, and assigning TZ there makes V8 reload its zone. That
        // holds for child processes only, so the pool is pinned to forks
        // (worker threads share the parent's zone). Each spec asserts the
        // offset in its first test.
        extends: true,
        test: {
          name: 'unit-new-york',
          include: ['src/web/calendar/**/*.spec.{ts,tsx}'],
          env: { TZ: 'America/New_York' },
          pool: 'forks',
        },
      },
      {
        // The real app in-process on a scratch Postgres database per spec
        // file and a temp DATA_PATH, driven through Fastify's inject(). Needs
        // pgvault-dev on localhost:5432 or TEST_DATABASE_URL (see
        // test/support/scratch-database.ts). Files run in parallel, each in
        // its own child process (the default forks pool with isolation), so
        // one file's app, rate-limit counters and mocks never meet another's
        // (test/integration/harness.ts).
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.spec.{ts,tsx}'],
          // Drops scratch databases that killed runs left on the server.
          globalSetup: ['test/support/sweep-scratch-databases.ts'],
        },
      },
    ],
  },
});
