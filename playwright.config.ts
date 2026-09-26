import { defineConfig, devices } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

// The committed .env's public defaults (APP_NAME) for the specs, under
// whatever the environment sets, as the server reads them (src/config.ts).
const committedEnv = parseEnv(
  readFileSync(path.resolve(__dirname, '.env'), 'utf8'),
);
for (const [key, value] of Object.entries(committedEnv)) {
  process.env[key] ??= value;
}
// The server refuses to boot without a signing secret (src/config.ts). The
// specs only sign in through the app, so a fresh one per run will do unless
// the caller (CI) passes its own. The webServer inherits process.env.
process.env.ACCESS_TOKEN_SECRET ??= randomBytes(32).toString('hex');

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './test',
  /* test/integration/ holds the Vitest in-process tier (npm run test:int). */
  testIgnore: '**/integration/**',
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: 'html',
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('')`. */
    baseURL: 'http://localhost:3000',

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },

    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },

    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },

    /* Test against mobile viewports. */
    {
      name: 'Mobile Chrome',
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'Mobile Safari',
      use: { ...devices['iPhone 12'] },
    },

    /* Test against branded browsers. */
    // {
    //   name: 'Microsoft Edge',
    //   use: { ...devices['Desktop Edge'], channel: 'msedge' },
    // },
    // {
    //   name: 'Google Chrome',
    //   use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    // },
  ],

  /* Outside CI a server already listening on :3000 is reused instead (a
   * start:dev or start:prod one runs the real model on uploads). */
  webServer: {
    // Serves the existing build (the npm scripts test:e2e and verify:push,
    // and CI, build first) with background removal stubbed: an upload's
    // cutout arrives 3 s later without the model (test/support/test-server.ts).
    command: 'npm run start:test',
    url: 'http://localhost:3000/healthz',
    reuseExistingServer: !process.env.CI,
    stderr: 'pipe',
  },
});
