import { defineConfig, devices } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import {
  APP_ORIGIN,
  E2E_SENTRY_DSN,
  ORDER_REVIEW_OWNER,
} from './test/support/e2e-session';

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
// Production runs with the metrics on: the pages load the timing beacon
// (public/js/vitals.js), and test/metrics.spec.ts reads /metrics.
process.env.METRICS_ENABLED ??= 'true';
// The order mail on (#25), against the test server's JMAP stand-in
// (test/support/jmap-stub.ts, never Fastmail), for the review list's spec
// (test/order-review.spec.ts), whose fixed account is the owner.
process.env.ORDER_MAIL_JMAP_TOKEN ??= 'fmu1-e2e-stand-in';
process.env.ORDER_MAIL_SENDERS ??= 'orders-owner@example.com';
process.env.ORDER_MAIL_OWNER ??= ORDER_REVIEW_OWNER;
// Error tracking on, as production runs it (Bugsink): signed-in pages load
// public/js/errors.js. The DSN is Bugsink's stand-in, which only
// test/client-errors.spec.ts listens on while it runs; the server's events
// meanwhile fail to send, logged and dropped, never reaching a real tracker.
process.env.SENTRY_DSN ??= E2E_SENTRY_DSN;

/**
 * A Safari tab (not the installed app) opens the install dialog over the
 * first page of every session (public/js/pwa.js, offerInstall), and it
 * takes every tap until dismissed. The Safari projects start as a user who
 * has dismissed it: @khmyznikov/pwa-install's own flag, which it reads from
 * sessionStorage or localStorage. test/install-dialog.spec.ts covers the
 * dialog itself, in Chromium.
 */
const INSTALL_DISMISSED = {
  cookies: [],
  origins: [
    {
      origin: APP_ORIGIN,
      localStorage: [{ name: 'pwa-hide-install', value: 'true' }],
    },
  ],
};

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
  /* CI's runner has 4 vCPUs beside the server and Postgres: two browsers.
   * Specs own their data (their own users; screenshots.spec.ts resets its
   * personas and runs serially in one worker), so they may run together. */
  workers: process.env.CI ? 2 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: 'html',
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('')`: :3000 unless
     * PORT names another, which the webServer then listens on. */
    baseURL: APP_ORIGIN,

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

    /* The Safari projects run nightly (.github/workflows/nightly.yml, #179). */
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'], storageState: INSTALL_DISMISSED },
    },

    /* Test against mobile viewports. */
    {
      name: 'Mobile Chrome',
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'Mobile Safari',
      use: { ...devices['iPhone 12'], storageState: INSTALL_DISMISSED },
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

  /* Outside CI a server already listening on the port is reused instead (a
   * start:dev or start:prod one runs the real model on uploads). */
  webServer: {
    // Serves the existing build (the npm scripts test:e2e and verify:push,
    // and CI, build first) with background removal stubbed: an upload's
    // cutout arrives 3 s later without the model (test/support/test-server.ts).
    command: 'npm run start:test',
    url: `${APP_ORIGIN}/healthz`,
    reuseExistingServer: !process.env.CI,
    stderr: 'pipe',
  },
});
