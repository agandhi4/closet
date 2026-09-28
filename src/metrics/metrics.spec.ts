import { describe, expect, it } from 'vitest';
import { captureLogs } from '../../test/support/log-capture';
import { Metrics } from './metrics';

function newMetrics(enabled = false) {
  const { logger, logs } = captureLogs();
  return { metrics: new Metrics({ enabled, logger }), logs };
}

describe('Metrics', () => {
  it('times a job as ok, or as error and rethrows', async () => {
    const { metrics } = newMetrics();
    const doubled = metrics.timeJob('reconciliation', (n: number) =>
      Promise.resolve(n * 2),
    );
    expect(await doubled(21)).toBe(42);
    const failing = metrics.timeJob('replan', () =>
      Promise.reject(new Error('pool ended')),
    );
    await expect(failing()).rejects.toThrow('pool ended');

    const { body } = await metrics.exposition();
    expect(body).toMatch(
      /^job_duration_seconds_count\{name="reconciliation",outcome="ok"\} 1$/m,
    );
    expect(body).toMatch(
      /^job_duration_seconds_count\{name="replan",outcome="error"\} 1$/m,
    );
  });

  it('never exposes a `job` label (the scraper sets it)', async () => {
    const { metrics } = newMetrics(true);
    metrics.addRoute('/calendar');
    metrics.observeRequest('/calendar', 'GET', 200, 0.01);
    metrics.observeJob('cutout', 'discarded', 2.5);
    metrics.countPushSend('delivered');
    metrics.observeMcpCall('list_garments', 'refused', 0.02);
    metrics.observeClientTiming({
      route: '/calendar',
      kind: 'htmx',
      cache: false,
      ms: { request: 100 },
    });
    const { body } = await metrics.exposition();
    expect(body).not.toMatch(/[{,]job="/);
    expect(body).toContain('push_sends_total{outcome="delivered"} 1');
    expect(body).toContain(
      'mcp_tool_call_duration_seconds_count{tool="list_garments",outcome="refused"} 1',
    );
    expect(body).toContain(
      'http_request_duration_seconds_count{route="/calendar",method="GET",status_class="2xx"} 1',
    );
  });

  it("records a device's sample only for a route the app has", async () => {
    const { metrics } = newMetrics();
    metrics.addRoute('/wardrobe/:id');
    const ms = { settle: 40 };
    expect(
      metrics.observeClientTiming({
        route: '/wardrobe/:id',
        kind: 'restore',
        cache: false,
        ms,
      }),
    ).toBe(true);
    expect(
      metrics.observeClientTiming({
        route: '/wardrobe/17',
        kind: 'restore',
        cache: false,
        ms,
      }),
    ).toBe(false);
    const { body } = await metrics.exposition();
    expect(body).not.toContain('/wardrobe/17');
    expect(body).toContain(
      'client_timing_dropped_total{reason="unknown_route"} 1',
    );
  });

  it("keeps the cutout queue's last depth when the database cannot answer", async () => {
    const { metrics, logs } = newMetrics();
    let depth: number | Error = 3;
    metrics.trackCutoutQueue(() =>
      depth instanceof Error ? Promise.reject(depth) : Promise.resolve(depth),
    );
    expect((await metrics.exposition()).body).toMatch(
      /^cutout_queue_depth 3$/m,
    );
    depth = new Error('connection refused');
    expect((await metrics.exposition()).body).toMatch(
      /^cutout_queue_depth 3$/m,
    );
    expect(logs.messages('warn')).toEqual([
      "Could not read the cutout queue's depth: connection refused",
    ]);
  });

  it('adds the process metrics only when enabled', async () => {
    expect((await newMetrics(false).metrics.exposition()).body).not.toContain(
      'process_cpu_user_seconds_total',
    );
    expect((await newMetrics(true).metrics.exposition()).body).toContain(
      'process_cpu_user_seconds_total',
    );
  });
});
