import { PassThrough, Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runSeed } from '../../src/seed/seed';
import { createTestApp, recordQueries, type TestApp } from './harness';
import { tool } from './mcp';

const PASSWORD = 'Closet-demo-1';
const ANCHOR = '2026-09-26';

/**
 * Insights (#17) over the seed's Theo (demo): thirteen weeks of simulated
 * wears must make every figure worth reading, not zero or everything. The
 * clock is pinned to the seed's anchor day, so the windows (30, 90, 365
 * days) see the history the bible was written for, whatever day CI runs.
 * The exact figures on a known closet are insights.spec.ts's.
 */
describe('insights over the seed personas', () => {
  let t: TestApp;
  let demoCookie: string;
  let demoToken: string;
  let stdout = '';

  beforeAll(async () => {
    vi.useFakeTimers({
      toFake: ['Date'],
      now: new Date(`${ANCHOR}T16:00:00Z`),
    });
    t = await createTestApp();
    const output = new PassThrough();
    output.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    const status = await runSeed({
      args: [
        ...['--persona', 'demo', '--persona', 'fresh'],
        ...['--anchor', ANCHOR, '--password-stdin', '--token'],
      ],
      db: t.db,
      photos: t.photos,
      logger: t.logger,
      timeZone: 'America/New_York',
      weatherEnabled: false,
      input: Readable.from([`${PASSWORD}\n`]),
      output,
      errors: new PassThrough(),
      now: new Date(),
    });
    expect(status, stdout).toBe(0);
    demoToken = /demo: MCP token (closet_\S+) /.exec(stdout)![1];
    demoCookie = await t.login('demo@closet.invalid', PASSWORD);
  }, 120_000);

  afterAll(async () => {
    vi.useRealTimers();
    await t?.cleanup();
  });

  const demoPage = (query = '') =>
    t.inject({
      method: 'GET',
      url: `/wardrobe/insights${query}`,
      headers: { cookie: demoCookie },
    });

  it('shows Theo every figure, none of them trivial', async () => {
    const res = await demoPage();
    expect(res.statusCode).toBe(200);
    const html = res.body;
    const percents = [
      ...html.matchAll(/data-window="\d+"[^]*?data-percent[^>]*>(\d+)%/g),
    ].map((m) => Number(m[1]));
    expect(percents).toHaveLength(3);
    for (const percent of percents) {
      expect(percent).toBeGreaterThan(0);
      expect(percent).toBeLessThan(100);
    }
    // Wider windows see at least as much.
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
    for (const id of [
      'insights-attention',
      'insights-unworn',
      'insights-most-worn',
      'insights-least-worn',
      'insights-best-value',
      'insights-most-per-wear',
      'insights-pairs',
      'insights-colours',
      'insights-categories',
      'insights-brands',
    ]) {
      expect(html, id).toContain(`id="${id}"`);
    }
    expect(html).not.toContain('id="insights-no-wears"');
    expect(html).toMatch(/data-unworn-count="[1-9]/);
    expect(html).toContain('data-pair=');
  });

  it('bounds the page to the owner row and two statements over 80 garments', async () => {
    const record = await recordQueries(() => demoPage());
    expect(record.statements).toBe(3);
    // The user, one row per garment in the closet, at most five pairs.
    expect(record.rows).toBeLessThanOrEqual(1 + 80 + 5);
  });

  it('gives Theo’s Claude the same figures', async () => {
    const stats = await tool<{
      closet: { garments: number };
      worn: { percent: number }[];
      mostWorn: unknown[];
      leastWorn: unknown[];
      costPerWear: { best: unknown[]; worst: unknown[] };
      pairs: unknown[];
      colours: unknown[];
      brands: unknown[];
      condition: { needsRepair: number; replaceSoon: number };
    }>(t, demoToken, 'wardrobe_stats', { unwornDays: 30 });
    expect(stats.closet.garments).toBe(80);
    expect(stats.mostWorn).toHaveLength(5);
    expect(stats.leastWorn).toHaveLength(5);
    expect(stats.costPerWear.best).toHaveLength(5);
    expect(stats.costPerWear.worst).toHaveLength(5);
    expect(stats.pairs.length).toBeGreaterThan(0);
    expect(stats.colours.length).toBeGreaterThan(3);
    expect(stats.brands.length).toBeGreaterThan(3);
    expect(
      stats.condition.needsRepair + stats.condition.replaceSoon,
    ).toBeGreaterThan(0);
  });

  it('shows Riley the empty state', async () => {
    const res = await t.inject({
      method: 'GET',
      url: '/wardrobe/insights',
      headers: { cookie: await t.login('fresh@closet.invalid', PASSWORD) },
    });
    expect(res.body).toContain('Nothing to measure yet.');
  });
});
