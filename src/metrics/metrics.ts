import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from '@prometheus-io/client';
import type { Logger } from '../logger';

/**
 * The process's Prometheus metrics (#115), read by the homelab's vmagent
 * from GET /metrics (src/web/metrics/routes.ts), through
 * @prometheus-io/client (prom-client's successor, #136). One registry per
 * app, never the library's global one, so the integration specs' apps never
 * share a series.
 *
 * The contract with the homelab (its Grafana dashboards read these names):
 * `http_request_duration_seconds{route,method,status_class}` and
 * `job_duration_seconds{name,outcome}`. No metric carries a `job` label: the
 * scraper sets it. Every label value comes from a closed set (a route
 * template, a job name below, a tool name, an outcome), never from a
 * request: no ids, no URLs, no user.
 *
 * Recording always happens (it is a few additions per request); only the
 * route that exposes them, the device beacon and the process's default
 * metrics are gated by METRICS_ENABLED.
 */

/**
 * The scheduled work timed into job_duration_seconds: the timers server.ts
 * starts, and each background-removal run of the cutout queue.
 */
export type JobName =
  | 'reconciliation'
  | 'cutout'
  | 'cutout_retry'
  | 'reminders'
  | 'reminder_prune'
  | 'replan'
  | 'replan_prune';

/**
 * A job's ending. `success` and `failure` are the homelab contract, shared
 * with finplat (homelab stacks/homeinfra/vmalert/rules/apps.yml): the
 * JobFailed alert and the RED dashboard select `outcome="failure"`. A
 * cutout run may also end `discarded` or `interrupted` (src/cutout/queue.ts).
 */
export type JobOutcome = 'success' | 'failure' | 'discarded' | 'interrupted';

export type PushOutcome = 'delivered' | 'pruned' | 'failed';

export type McpOutcome = 'ok' | 'refused' | 'error';

/** Where a device's timing came from (public/js/vitals.js). */
export const CLIENT_TIMING_KINDS = ['full', 'htmx', 'restore'] as const;
export type ClientTimingKind = (typeof CLIENT_TIMING_KINDS)[number];

/**
 * What a device measures, in milliseconds. `ttfb` and `lcp` are a full
 * load's; `request` (sent to answered) and `settle` (answered to swapped
 * and settled) an htmx request's; `settle` alone a history restore's; `inp`
 * the slowest interaction while a page was on screen.
 */
export const CLIENT_TIMING_METRICS = [
  'ttfb',
  'lcp',
  'inp',
  'request',
  'settle',
] as const;
export type ClientTimingMetric = (typeof CLIENT_TIMING_METRICS)[number];

export interface ClientTimingSample {
  /** A route template the device read from Server-Timing (`/wardrobe/:id`). */
  route: string;
  kind: ClientTimingKind;
  /** Answered from the service worker's page cache. */
  cache: boolean;
  ms: Partial<Record<ClientTimingMetric, number>>;
}

const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const JOB_BUCKETS = [0.01, 0.05, 0.25, 1, 2.5, 5, 10, 30, 60, 120, 300];
// A phone on the tailnet: from a cached swap (tens of ms) to a cold load
// over a poor connection (seconds).
const CLIENT_BUCKETS = [
  0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 0.8, 1.2, 2, 3, 5, 8, 13,
];

export interface MetricsOptions {
  /** METRICS_ENABLED: adds the process's default metrics (CPU, memory, event loop). */
  enabled: boolean;
  logger: Logger;
}

export class Metrics {
  readonly registry = new Registry();
  readonly enabled: boolean;

  private readonly httpDuration: Histogram<'route' | 'method' | 'status_class'>;
  private readonly jobDuration: Histogram<'name' | 'outcome'>;
  private readonly pushSends: Counter<'outcome'>;
  private readonly mcpCalls: Histogram<'tool' | 'outcome'>;
  private readonly clientTiming: Histogram<
    'route' | 'kind' | 'metric' | 'cache'
  >;
  private readonly clientDropped: Counter<'reason'>;
  // Every route the app registered (registerHttpMetrics' onRoute hook): the
  // only values a device may name as its route.
  private readonly routeTemplates = new Set<string>();
  private readonly logger: Logger;

  constructor({ enabled, logger }: MetricsOptions) {
    this.enabled = enabled;
    this.logger = logger;
    const registers = [this.registry];
    this.httpDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'Time from request to response, by route template, method and status class.',
      labelNames: ['route', 'method', 'status_class'],
      buckets: HTTP_BUCKETS,
      registers,
    });
    this.jobDuration = new Histogram({
      name: 'job_duration_seconds',
      help: 'Scheduled and background jobs: run time by job name and outcome.',
      labelNames: ['name', 'outcome'],
      buckets: JOB_BUCKETS,
      registers,
    });
    this.pushSends = new Counter({
      name: 'push_sends_total',
      help: 'Web Push sends, one per device, by outcome.',
      labelNames: ['outcome'],
      registers,
    });
    this.mcpCalls = new Histogram({
      name: 'mcp_tool_call_duration_seconds',
      help: 'MCP tool calls by tool and outcome.',
      labelNames: ['tool', 'outcome'],
      buckets: HTTP_BUCKETS,
      registers,
    });
    this.clientTiming = new Histogram({
      name: 'client_timing_seconds',
      help: "Devices' own timings (public/js/vitals.js) by route template, navigation kind, metric and service-worker cache hit.",
      labelNames: ['route', 'kind', 'metric', 'cache'],
      buckets: CLIENT_BUCKETS,
      registers,
    });
    this.clientDropped = new Counter({
      name: 'client_timing_dropped_total',
      help: 'Device timing samples dropped, by reason.',
      labelNames: ['reason'],
      registers,
    });
    if (enabled) collectDefaultMetrics({ register: this.registry });
  }

  /** Called for every route as it is registered (registerHttpMetrics). */
  addRoute(template: string): void {
    this.routeTemplates.add(template);
  }

  observeRequest(
    route: string,
    method: string,
    status: number,
    seconds: number,
  ): void {
    this.httpDuration.observe(
      { route, method, status_class: `${Math.floor(status / 100)}xx` },
      seconds,
    );
  }

  observeJob(name: JobName, outcome: JobOutcome, seconds: number): void {
    this.jobDuration.observe({ name, outcome }, seconds);
  }

  /**
   * A scheduled job's `run`, timed under `name` (server.ts wraps every timer
   * it starts): `success`, or `failure` when it throws (rethrown, for the
   * scheduler to log).
   */
  timeJob<A extends unknown[], T>(
    name: JobName,
    run: (...args: A) => Promise<T>,
  ): (...args: A) => Promise<T> {
    return async (...args) => {
      const started = performance.now();
      let outcome: JobOutcome = 'failure';
      try {
        const result = await run(...args);
        outcome = 'success';
        return result;
      } finally {
        this.observeJob(name, outcome, (performance.now() - started) / 1000);
      }
    };
  }

  countPushSend(outcome: PushOutcome): void {
    this.pushSends.inc({ outcome });
  }

  observeMcpCall(tool: string, outcome: McpOutcome, seconds: number): void {
    this.mcpCalls.observe({ tool, outcome }, seconds);
  }

  /**
   * The background-removal queue's pending photos, read from the database
   * at each scrape (a gauge that is never stale). A failed read is logged
   * and the scrape keeps the last value rather than failing whole.
   */
  trackCutoutQueue(pending: () => Promise<number>): void {
    const logger = this.logger;
    new Gauge({
      name: 'cutout_queue_depth',
      help: 'Photos waiting for background removal (pending cutouts).',
      registers: [this.registry],
      async collect() {
        try {
          this.set(await pending());
        } catch (error) {
          logger.warn(
            `Could not read the cutout queue's depth: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    });
  }

  /**
   * Records one device sample. A route the app does not have is dropped
   * (and counted), so a device cannot add a series of its choosing.
   * Returns whether it was recorded.
   */
  observeClientTiming(sample: ClientTimingSample): boolean {
    if (!this.routeTemplates.has(sample.route)) {
      this.clientDropped.inc({ reason: 'unknown_route' });
      return false;
    }
    const cache = sample.cache ? 'hit' : 'miss';
    for (const metric of CLIENT_TIMING_METRICS) {
      const ms = sample.ms[metric];
      if (ms === undefined) continue;
      this.clientTiming.observe(
        { route: sample.route, kind: sample.kind, metric, cache },
        ms / 1000,
      );
    }
    return true;
  }

  /** The exposition text and its content type, for GET /metrics. */
  async exposition(): Promise<{ contentType: string; body: string }> {
    return {
      contentType: this.registry.contentType,
      body: await this.registry.metrics(),
    };
  }
}
