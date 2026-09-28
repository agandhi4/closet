import { describe, expect, it, vi } from 'vitest';
import { captureLogs } from '../../test/support/log-capture';
import { recordErrors } from '../../test/support/sentry-stub';
import { Metrics } from './metrics';

function newMetrics(enabled = false) {
  const { logger, logs } = captureLogs();
  const errors = recordErrors();
  return {
    metrics: new Metrics({ enabled, logger, errors: errors.tracker }),
    logs,
    errors,
  };
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

  it('counts photos served by how their files were found', async () => {
    const { metrics } = newMetrics(true);
    metrics.countPhotoRequest('none');
    metrics.countPhotoRequest('none');
    metrics.countPhotoRequest('row');
    const { body } = await metrics.exposition();
    expect(body).toContain('photo_requests_total{lookup="none"} 2');
    expect(body).toContain('photo_requests_total{lookup="row"} 1');
  });

  it('never exposes a `job` label (the scraper sets it)', async () => {
    const { metrics } = newMetrics(true);
    metrics.addRoute('/calendar');
    metrics.observeRequest('/calendar', 'GET', 200, 0.01);
    metrics.observeJob('cutout', { outcome: 'discarded' }, 2.5);
    metrics.countPushSend({ outcome: 'delivered' });
    metrics.observeMcpCall('list_garments', { outcome: 'refused' }, 0.02);
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

  // #117: the failure outcomes are the error tracker's choke points.
  it('hands every failure, and only failures, to the error tracker', async () => {
    const { metrics, errors } = newMetrics();
    await metrics.timeJob('reconciliation', () => Promise.resolve())();
    const jobError = new Error('disk gone');
    await expect(
      metrics.timeJob('reminders', () => Promise.reject(jobError))(),
    ).rejects.toBe(jobError);
    const cutoutError = new Error('model crashed');
    metrics.observeJob('cutout', { outcome: 'discarded' }, 1);
    metrics.observeJob('cutout', { outcome: 'failure', error: cutoutError }, 1);
    const pushError = new Error('HTTP 403');
    metrics.countPushSend({ outcome: 'delivered' });
    metrics.countPushSend({ outcome: 'pruned' });
    metrics.countPushSend({ outcome: 'failed', error: pushError });
    const toolError = new Error('boom');
    metrics.observeMcpCall('list_garments', { outcome: 'refused' }, 0.01);
    metrics.observeMcpCall(
      'list_garments',
      { outcome: 'error', error: toolError },
      0.01,
    );

    expect(errors.exceptions).toEqual([
      {
        error: jobError,
        context: { source: 'job', tags: { job: 'reminders' } },
      },
      {
        error: cutoutError,
        context: { source: 'job', tags: { job: 'cutout' } },
      },
      { error: pushError, context: { source: 'push' } },
      {
        error: toolError,
        context: { source: 'mcp', tags: { tool: 'list_garments' } },
      },
    ]);
    const { body } = await metrics.exposition();
    expect(body).toMatch(
      /^job_duration_seconds_count\{name="reminders",outcome="failure"\} 1$/m,
    );
    expect(body).toContain('push_sends_total{outcome="failed"} 1');
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

  describe("the cutout queue's depth", () => {
    // Each count the gauge starts, answered when the spec says.
    function scriptedCounts() {
      const counts: { resolve: (depth: number) => void }[] = [];
      return {
        counts,
        pending: () =>
          new Promise<number>((resolve) => counts.push({ resolve })),
      };
    }

    it('waits for the first count, when nothing was read yet', async () => {
      const { metrics } = newMetrics();
      const { counts, pending } = scriptedCounts();
      metrics.trackCutoutQueue(pending);
      const scrape = metrics.exposition();
      await vi.waitFor(() => expect(counts).toHaveLength(1));
      counts[0].resolve(3);
      expect((await scrape).body).toMatch(/^cutout_queue_depth 3$/m);
    });

    // In production the count is a round trip to pgvault, which was most of
    // every scrape's time (#174).
    it('answers later scrapes with the last count, never waiting for the database', async () => {
      const { metrics } = newMetrics();
      const { counts, pending } = scriptedCounts();
      metrics.trackCutoutQueue(pending);
      const first = metrics.exposition();
      await vi.waitFor(() => expect(counts).toHaveLength(1));
      counts[0].resolve(3);
      await first;

      // The second scrape's count never answers before the scrape does.
      expect((await metrics.exposition()).body).toMatch(
        /^cutout_queue_depth 3$/m,
      );
      expect(counts).toHaveLength(2);
      // While it is out, a scrape starts no other count.
      expect((await metrics.exposition()).body).toMatch(
        /^cutout_queue_depth 3$/m,
      );
      expect(counts).toHaveLength(2);

      counts[1].resolve(5);
      await new Promise((settled) => setImmediate(settled));
      expect((await metrics.exposition()).body).toMatch(
        /^cutout_queue_depth 5$/m,
      );
      expect(counts).toHaveLength(3);
    });

    it('keeps the last depth when the database cannot answer', async () => {
      const { metrics, logs } = newMetrics();
      let depth: number | Error = 3;
      metrics.trackCutoutQueue(() =>
        depth instanceof Error ? Promise.reject(depth) : Promise.resolve(depth),
      );
      expect((await metrics.exposition()).body).toMatch(
        /^cutout_queue_depth 3$/m,
      );
      depth = new Error('connection refused');
      await metrics.exposition();
      await vi.waitFor(() =>
        expect(logs.messages('warn')).toEqual([
          "Could not read the cutout queue's depth: connection refused",
        ]),
      );
      expect((await metrics.exposition()).body).toMatch(
        /^cutout_queue_depth 3$/m,
      );
    });

    // Past the first scrape nothing awaits the count, so a throw in its
    // handling would be an unhandled rejection: a crash in production
    // (main.ts). Watched on the process itself, not left to Vitest.
    it.each([
      ['NaN', Number.NaN],
      ['a string', '4' as unknown as number],
      ['Infinity', Number.POSITIVE_INFINITY],
    ])(
      'keeps the last depth and logs when a count is %s, rejecting nothing',
      async (_name, bad) => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => unhandled.push(reason);
        process.on('unhandledRejection', onUnhandled);
        try {
          const { metrics, logs } = newMetrics();
          let depth = 3;
          metrics.trackCutoutQueue(() => Promise.resolve(depth));
          expect((await metrics.exposition()).body).toMatch(
            /^cutout_queue_depth 3$/m,
          );
          depth = bad;
          await metrics.exposition();
          await vi.waitFor(() =>
            expect(logs.messages('warn')).toEqual([
              `Could not read the cutout queue's depth: not a count: ${String(bad)}`,
            ]),
          );
          await new Promise((settled) => setImmediate(settled));
          expect((await metrics.exposition()).body).toMatch(
            /^cutout_queue_depth 3$/m,
          );
          expect(unhandled).toEqual([]);
        } finally {
          process.off('unhandledRejection', onUnhandled);
        }
      },
    );

    it('stops waiting after a first count that failed, the gauge at 0', async () => {
      const { metrics, logs } = newMetrics();
      const counts: { reject: (error: Error) => void }[] = [];
      metrics.trackCutoutQueue(
        () =>
          new Promise<number>((_resolve, reject) => counts.push({ reject })),
      );
      const first = metrics.exposition();
      await vi.waitFor(() => expect(counts).toHaveLength(1));
      counts[0].reject(new Error('connection refused'));
      expect((await first).body).toMatch(/^cutout_queue_depth 0$/m);
      expect(logs.messages('warn')).toEqual([
        "Could not read the cutout queue's depth: connection refused",
      ]);
      // The next count never answers; the scrape does not wait for it.
      expect((await metrics.exposition()).body).toMatch(
        /^cutout_queue_depth 0$/m,
      );
      expect(counts).toHaveLength(2);
    });

    it('survives a count that throws before it is a promise', async () => {
      const { metrics, logs } = newMetrics();
      let calls = 0;
      metrics.trackCutoutQueue(() => {
        calls += 1;
        if (calls === 1) throw new Error('pool closed');
        return Promise.resolve(2);
      });
      expect((await metrics.exposition()).body).toMatch(
        /^cutout_queue_depth 0$/m,
      );
      expect(logs.messages('warn')).toEqual([
        "Could not read the cutout queue's depth: pool closed",
      ]);
      // A later scrape starts a count again: the first did not stay stuck.
      await metrics.exposition();
      await new Promise((settled) => setImmediate(settled));
      expect((await metrics.exposition()).body).toMatch(
        /^cutout_queue_depth 2$/m,
      );
      expect(calls).toBe(3);
    });
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
    metrics.countPushSend({ outcome: 'delivered' });
    metrics.observeMcpCall('list_garments', { outcome: 'ok' }, 0.02);
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
        "# TYPE photo_requests_total counter",
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
