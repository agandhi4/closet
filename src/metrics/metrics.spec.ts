import { describe, expect, it } from 'vitest';
import { captureLogs } from '../../test/support/log-capture';
import { Metrics } from './metrics';

function newMetrics(enabled = false) {
  const { logger, logs } = captureLogs();
  return { metrics: new Metrics({ enabled, logger }), logs };
}

/**
 * What a scraper depends on in an exposition, sorted: every family's
 * `# TYPE` line, and every series as its name and label names. Label order
 * and values are free, except the values the homelab selects by: `le` (the
 * buckets) and job_duration_seconds' `outcome` (the JobFailed alert and the
 * RED dashboard read `outcome="failure"`). Help text and sample values are
 * left out.
 */
function expositionContract(body: string): string[] {
  const lines = new Set<string>();
  for (const line of body.split('\n')) {
    if (line.startsWith('# TYPE ')) {
      lines.add(line);
      continue;
    }
    if (line === '' || line.startsWith('#')) continue;
    const series = /^(\w+)(?:\{(.*)\})? \S+$/.exec(line);
    if (!series) throw new Error(`Unparsed exposition line: ${line}`);
    const labels = [...(series[2] ?? '').matchAll(/(\w+)="(?:[^"\\]|\\.)*"/g)]
      .map(([pair, name]) =>
        name === 'le' ||
        (name === 'outcome' && series[1].startsWith('job_duration_seconds'))
          ? pair
          : name,
      )
      .sort();
    lines.add(`${series[1]}{${labels.join(',')}}`);
  }
  return [...lines].sort();
}

// prom-client 15's default metrics, as the homelab has been scraping them
// since #115 (the Linux-only ones read /proc).
const DEFAULT_FAMILIES = [
  '# TYPE nodejs_active_handles gauge',
  '# TYPE nodejs_active_handles_total gauge',
  '# TYPE nodejs_active_requests gauge',
  '# TYPE nodejs_active_requests_total gauge',
  '# TYPE nodejs_active_resources gauge',
  '# TYPE nodejs_active_resources_total gauge',
  '# TYPE nodejs_eventloop_lag_max_seconds gauge',
  '# TYPE nodejs_eventloop_lag_mean_seconds gauge',
  '# TYPE nodejs_eventloop_lag_min_seconds gauge',
  '# TYPE nodejs_eventloop_lag_p50_seconds gauge',
  '# TYPE nodejs_eventloop_lag_p90_seconds gauge',
  '# TYPE nodejs_eventloop_lag_p99_seconds gauge',
  '# TYPE nodejs_eventloop_lag_seconds gauge',
  '# TYPE nodejs_eventloop_lag_stddev_seconds gauge',
  '# TYPE nodejs_external_memory_bytes gauge',
  '# TYPE nodejs_gc_duration_seconds histogram',
  '# TYPE nodejs_heap_size_total_bytes gauge',
  '# TYPE nodejs_heap_size_used_bytes gauge',
  '# TYPE nodejs_heap_space_size_available_bytes gauge',
  '# TYPE nodejs_heap_space_size_total_bytes gauge',
  '# TYPE nodejs_heap_space_size_used_bytes gauge',
  '# TYPE nodejs_version_info gauge',
  '# TYPE process_cpu_seconds_total counter',
  '# TYPE process_cpu_system_seconds_total counter',
  '# TYPE process_cpu_user_seconds_total counter',
  '# TYPE process_resident_memory_bytes gauge',
  '# TYPE process_start_time_seconds gauge',
  ...(process.platform === 'linux'
    ? [
        '# TYPE process_heap_bytes gauge',
        '# TYPE process_max_fds gauge',
        '# TYPE process_open_fds gauge',
        '# TYPE process_virtual_memory_bytes gauge',
      ]
    : []),
];

describe('Metrics', () => {
  it('times a job as success, or as failure and rethrows', async () => {
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
      /^job_duration_seconds_count\{name="reconciliation",outcome="success"\} 1$/m,
    );
    expect(body).toMatch(
      /^job_duration_seconds_count\{name="replan",outcome="failure"\} 1$/m,
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

  // The homelab's dashboards and alerts (homelab #39) read these names,
  // types and labels: a client library change (#136: prom-client to
  // @prometheus-io/client) or a refactor must not move them. The values
  // they select by are kept whole: `le`, and a job's `outcome`.
  it("keeps the exposition's names, types and labels (the homelab contract)", async () => {
    const { metrics } = newMetrics();
    metrics.addRoute('/calendar');
    metrics.observeRequest('/calendar', 'GET', 200, 0.01);
    await metrics.timeJob('reconciliation', () => Promise.resolve())();
    await expect(
      metrics.timeJob('replan', () => Promise.reject(new Error('down')))(),
    ).rejects.toThrow('down');
    metrics.countPushSend('delivered');
    metrics.observeMcpCall('list_garments', 'ok', 0.02);
    metrics.observeClientTiming({
      route: '/calendar',
      kind: 'full',
      cache: true,
      ms: { ttfb: 80 },
    });
    metrics.observeClientTiming({
      route: '/nowhere',
      kind: 'htmx',
      cache: false,
      ms: { request: 1 },
    });
    metrics.trackCutoutQueue(() => Promise.resolve(2));

    const { contentType, body } = await metrics.exposition();
    expect(contentType).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(expositionContract(body)).toMatchInlineSnapshot(`
      [
        "# TYPE client_timing_dropped_total counter",
        "# TYPE client_timing_seconds histogram",
        "# TYPE cutout_queue_depth gauge",
        "# TYPE http_request_duration_seconds histogram",
        "# TYPE job_duration_seconds histogram",
        "# TYPE mcp_tool_call_duration_seconds histogram",
        "# TYPE push_sends_total counter",
        "client_timing_dropped_total{reason}",
        "client_timing_seconds_bucket{cache,kind,le="+Inf",metric,route}",
        "client_timing_seconds_bucket{cache,kind,le="0.025",metric,route}",
        "client_timing_seconds_bucket{cache,kind,le="0.05",metric,route}",
        "client_timing_seconds_bucket{cache,kind,le="0.1",metric,route}",
        "client_timing_seconds_bucket{cache,kind,le="0.2",metric,route}",
        "client_timing_seconds_bucket{cache,kind,le="0.3",metric,route}",
        "client_timing_seconds_bucket{cache,kind,le="0.5",metric,route}",
        "client_timing_seconds_bucket{cache,kind,le="0.8",metric,route}",
        "client_timing_seconds_bucket{cache,kind,le="1.2",metric,route}",
        "client_timing_seconds_bucket{cache,kind,le="13",metric,route}",
        "client_timing_seconds_bucket{cache,kind,le="2",metric,route}",
        "client_timing_seconds_bucket{cache,kind,le="3",metric,route}",
        "client_timing_seconds_bucket{cache,kind,le="5",metric,route}",
        "client_timing_seconds_bucket{cache,kind,le="8",metric,route}",
        "client_timing_seconds_count{cache,kind,metric,route}",
        "client_timing_seconds_sum{cache,kind,metric,route}",
        "cutout_queue_depth{}",
        "http_request_duration_seconds_bucket{le="+Inf",method,route,status_class}",
        "http_request_duration_seconds_bucket{le="0.005",method,route,status_class}",
        "http_request_duration_seconds_bucket{le="0.01",method,route,status_class}",
        "http_request_duration_seconds_bucket{le="0.025",method,route,status_class}",
        "http_request_duration_seconds_bucket{le="0.05",method,route,status_class}",
        "http_request_duration_seconds_bucket{le="0.1",method,route,status_class}",
        "http_request_duration_seconds_bucket{le="0.25",method,route,status_class}",
        "http_request_duration_seconds_bucket{le="0.5",method,route,status_class}",
        "http_request_duration_seconds_bucket{le="1",method,route,status_class}",
        "http_request_duration_seconds_bucket{le="10",method,route,status_class}",
        "http_request_duration_seconds_bucket{le="2.5",method,route,status_class}",
        "http_request_duration_seconds_bucket{le="5",method,route,status_class}",
        "http_request_duration_seconds_count{method,route,status_class}",
        "http_request_duration_seconds_sum{method,route,status_class}",
        "job_duration_seconds_bucket{le="+Inf",name,outcome="failure"}",
        "job_duration_seconds_bucket{le="+Inf",name,outcome="success"}",
        "job_duration_seconds_bucket{le="0.01",name,outcome="failure"}",
        "job_duration_seconds_bucket{le="0.01",name,outcome="success"}",
        "job_duration_seconds_bucket{le="0.05",name,outcome="failure"}",
        "job_duration_seconds_bucket{le="0.05",name,outcome="success"}",
        "job_duration_seconds_bucket{le="0.25",name,outcome="failure"}",
        "job_duration_seconds_bucket{le="0.25",name,outcome="success"}",
        "job_duration_seconds_bucket{le="1",name,outcome="failure"}",
        "job_duration_seconds_bucket{le="1",name,outcome="success"}",
        "job_duration_seconds_bucket{le="10",name,outcome="failure"}",
        "job_duration_seconds_bucket{le="10",name,outcome="success"}",
        "job_duration_seconds_bucket{le="120",name,outcome="failure"}",
        "job_duration_seconds_bucket{le="120",name,outcome="success"}",
        "job_duration_seconds_bucket{le="2.5",name,outcome="failure"}",
        "job_duration_seconds_bucket{le="2.5",name,outcome="success"}",
        "job_duration_seconds_bucket{le="30",name,outcome="failure"}",
        "job_duration_seconds_bucket{le="30",name,outcome="success"}",
        "job_duration_seconds_bucket{le="300",name,outcome="failure"}",
        "job_duration_seconds_bucket{le="300",name,outcome="success"}",
        "job_duration_seconds_bucket{le="5",name,outcome="failure"}",
        "job_duration_seconds_bucket{le="5",name,outcome="success"}",
        "job_duration_seconds_bucket{le="60",name,outcome="failure"}",
        "job_duration_seconds_bucket{le="60",name,outcome="success"}",
        "job_duration_seconds_count{name,outcome="failure"}",
        "job_duration_seconds_count{name,outcome="success"}",
        "job_duration_seconds_sum{name,outcome="failure"}",
        "job_duration_seconds_sum{name,outcome="success"}",
        "mcp_tool_call_duration_seconds_bucket{le="+Inf",outcome,tool}",
        "mcp_tool_call_duration_seconds_bucket{le="0.005",outcome,tool}",
        "mcp_tool_call_duration_seconds_bucket{le="0.01",outcome,tool}",
        "mcp_tool_call_duration_seconds_bucket{le="0.025",outcome,tool}",
        "mcp_tool_call_duration_seconds_bucket{le="0.05",outcome,tool}",
        "mcp_tool_call_duration_seconds_bucket{le="0.1",outcome,tool}",
        "mcp_tool_call_duration_seconds_bucket{le="0.25",outcome,tool}",
        "mcp_tool_call_duration_seconds_bucket{le="0.5",outcome,tool}",
        "mcp_tool_call_duration_seconds_bucket{le="1",outcome,tool}",
        "mcp_tool_call_duration_seconds_bucket{le="10",outcome,tool}",
        "mcp_tool_call_duration_seconds_bucket{le="2.5",outcome,tool}",
        "mcp_tool_call_duration_seconds_bucket{le="5",outcome,tool}",
        "mcp_tool_call_duration_seconds_count{outcome,tool}",
        "mcp_tool_call_duration_seconds_sum{outcome,tool}",
        "push_sends_total{outcome}",
      ]
    `);
  });

  it('keeps the default process metrics when enabled', async () => {
    const { body } = await newMetrics(true).metrics.exposition();
    const families = expositionContract(body).filter((line) =>
      line.startsWith('# TYPE'),
    );
    expect(families).toEqual(expect.arrayContaining(DEFAULT_FAMILIES));
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
