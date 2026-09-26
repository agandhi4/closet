import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Two tiers, one run (`npm run test:all`, the pre-commit hook): one worker
// pool, one coverage report. `npm test` selects the unit projects (`unit*`),
// `npm run test:int` the integration project.
export default defineConfig({
  // Nest resolves constructor injection from decorator metadata
  // (emitDecoratorMetadata), which Vite's own TypeScript transform never
  // emits: without SWC every injected dependency is undefined. unplugin-swc
  // reads experimentalDecorators/emitDecoratorMetadata from tsconfig.json and
  // turns Vite's transform off. It also reads jsx/jsxImportSource there
  // (hono/jsx for the src/web/ views) and then parses every .ts file as TSX,
  // which is why angle-bracket type assertions are banned (eslint.config.mjs).
  plugins: [swc.vite({ module: { type: 'es6' } })],
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
      exclude: [
        'src/**/*.spec.{ts,tsx}',
        'src/**/migrations/**',
        'src/**/entity/**',
        'src/**/*.dto.*',
        'src/**/*.module.*',
        'src/main.ts',
      ],
      reportsDirectory: 'coverage',
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.spec.{ts,tsx}'],
          exclude: [
            'src/wardrobe/calendar-dates.spec.ts',
            'src/web/calendar/**/*.spec.{ts,tsx}',
          ],
        },
      },
      {
        // The calendar's date logic in a DST zone: UTC (CI's zone) hides
        // every local-time mistake. `env` is applied to the worker's real
        // process.env before the spec is imported, and assigning TZ there
        // makes V8 reload its zone. That holds for child processes only, so
        // the pool is pinned to forks (worker threads share the parent's
        // zone). The spec asserts the offset in its first test.
        extends: true,
        test: {
          name: 'unit-new-york',
          include: [
            'src/wardrobe/calendar-dates.spec.ts',
            'src/web/calendar/**/*.spec.{ts,tsx}',
          ],
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
        // the env createTestApp writes into process.env and the AppModule it
        // boots never outlive the file (test/integration/harness.ts).
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.spec.{ts,tsx}'],
        },
      },
    ],
  },
});
