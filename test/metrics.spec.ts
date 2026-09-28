import { expect, type Page, type Request, test } from '@playwright/test';
import { signIn } from './support/e2e-session';

/**
 * The device's timings (#115, public/js/vitals.js): a boosted navigation is
 * measured and beaconed to POST /metrics/vitals under its route template,
 * and lands in the server's histograms. Skips unless the server runs with
 * METRICS_ENABLED (playwright.config.ts sets it for the server it starts).
 */

interface Sample {
  route: string;
  kind: string;
  cache: boolean;
  ms: Record<string, number>;
}

/** The count of one client_timing_seconds series, 0 before its first sample. */
async function sampleCount(
  page: Page,
  route: string,
  kind: string,
  metric: string,
): Promise<number> {
  const body = await (await page.request.get('/metrics')).text();
  const prefix = `client_timing_seconds_count{route="${route}",kind="${kind}",metric="${metric}",`;
  return body
    .split('\n')
    .filter((line) => line.startsWith(prefix))
    .reduce((sum, line) => sum + Number(line.split(' ').pop()), 0);
}

/**
 * Every sample the page beacons from now on. A batch goes out a few seconds
 * after its first sample, so a tap's may share it with a fragment the page
 * loaded before (the weather line) or follow in the next.
 */
function collectSamples(page: Page): Sample[] {
  const samples: Sample[] = [];
  page.on('request', (request: Request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname === '/metrics/vitals'
    ) {
      const body = JSON.parse(request.postData() ?? '{}') as {
        samples: Sample[];
      };
      samples.push(...body.samples);
    }
  });
  return samples;
}

async function sampleOf(
  samples: Sample[],
  route: string,
  kind: string,
): Promise<Sample> {
  const find = () => samples.find((s) => s.route === route && s.kind === kind);
  await expect.poll(find, { timeout: 15_000 }).toBeDefined();
  return find()!;
}

test.beforeEach(async ({ request }) => {
  const res = await request.get('/metrics');
  test.skip(res.status() === 404, 'the server runs without METRICS_ENABLED');
});

test('a boosted navigation records an htmx sample by route template', async ({
  page,
}) => {
  await signIn(page, 'vitals');
  await page.goto('/wardrobe');
  const before = await sampleCount(page, '/calendar', 'htmx', 'request');
  const samples = collectSamples(page);

  await page.locator('.dock').getByRole('link', { name: 'Calendar' }).click();
  await expect(page).toHaveURL(/\/calendar$/);

  // The tap: request and settle, named by the route's template.
  const tap = await sampleOf(samples, '/calendar', 'htmx');
  expect(tap.cache).toBe(false);
  expect(tap.ms.request).toBeGreaterThanOrEqual(0);
  expect(tap.ms.settle).toBeGreaterThanOrEqual(0);
  // The full load it left, ended by the navigation: its time to first byte,
  // named from Navigation Timing's Server-Timing.
  const load = await sampleOf(samples, '/wardrobe', 'full');
  expect(load.ms.ttfb).toBeGreaterThan(0);
  // No URL, id or query string travels.
  for (const sample of samples) expect(sample.route).not.toMatch(/\d|\?/);

  await expect
    .poll(() => sampleCount(page, '/calendar', 'htmx', 'request'))
    .toBeGreaterThan(before);
});

test("the calendar's week navigation is measured as the calendar", async ({
  page,
}) => {
  await signIn(page, 'vitals-week');
  await page.goto('/calendar');
  const samples = collectSamples(page);
  await page.getByRole('link', { name: 'Next week' }).click();
  await expect(page).toHaveURL(/\/calendar\?week=/);
  await sampleOf(samples, '/calendar', 'htmx');
});
