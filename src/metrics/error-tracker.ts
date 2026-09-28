// Types only: the SDK itself (Sentry and OpenTelemetry, tens of MB of
// modules) is loaded by createErrorTracker, and only with a DSN.
import type { ErrorEvent, Scope } from '@sentry/node';
import type { Logger } from '../logger';
import { SESSION_COOKIE } from '../web/auth/session';
import { TOKEN_PREFIX } from '../web/auth/personal-tokens';

/**
 * Error tracking (#117): the process's failures, sent to the homelab's
 * Bugsink (Sentry-compatible, `SENTRY_DSN`, the tracker finplat reports to).
 * Only with a DSN: without one `createErrorTracker` answers a tracker that
 * does nothing, and nothing of Sentry's runs.
 *
 * Captured at single choke points, never ad hoc: the error handler's
 * unexpected 500s (src/web/errors.tsx), and every failure outcome the
 * metrics record (a job, a push send, an MCP tool: src/metrics/metrics.ts),
 * plus the pages' script errors (POST /errors/client). Each capture names
 * its `source` and a few bounded tags (a route template, a job or tool
 * name), never a URL, header or body.
 *
 * One client per app, never Sentry's global one (`Sentry.init`): the
 * integration specs boot many apps in one process, as the metrics keep one
 * registry per app. So there are no automatic integrations either (no HTTP
 * or console breadcrumbs, no request data, no process handlers): an event
 * holds the error, its stack and what the capture named, and `scrubEvent`
 * is the net under all of it. The production entry adds one process-level
 * capture of its own: `createCrashHandler`, installed by main.ts.
 */

/** Where an error was captured: a tag, so Bugsink can filter by it. */
export type ErrorSource =
  | 'route'
  | 'job'
  | 'push'
  | 'mcp'
  | 'client'
  | 'process';

export interface ErrorContext {
  source: ErrorSource;
  /** Values from a closed set only: a route template, a method, a job or tool name. */
  tags?: Record<string, string>;
  userId?: number;
}

/** What a page's script reported (public/js/errors.js), validated by its route. */
export interface ClientErrorReport {
  message: string;
  stack?: string;
  /** A route template this app has; absent when the page named none. */
  route?: string;
  /**
   * The release the page says it was served by (a cached page may be
   * older). A tag, `page_release`, never the event's release: that is the
   * server's own, so no signed-in user can file an event under another.
   */
  release?: string;
}

export interface ErrorTracker {
  /** SENTRY_DSN was set: the tracker sends, and the pages' beacon exists. */
  readonly enabled: boolean;
  captureException(error: unknown, context: ErrorContext): void;
  captureClientError(report: ClientErrorReport, userId: number): void;
  /** Sends what is queued, waiting at most `timeoutMs` (the crash handler). */
  flush(timeoutMs: number): Promise<void>;
  /** Sends what is queued (up to `timeoutMs`), then stops. createApp's onClose. */
  close(timeoutMs?: number): Promise<void>;
}

/** No DSN: nothing is captured or sent. Also what unit specs pass to Metrics. */
export const DISABLED_ERROR_TRACKER: ErrorTracker = {
  enabled: false,
  captureException() {},
  captureClientError() {},
  flush: () => Promise.resolve(),
  close: () => Promise.resolve(),
};

/** The Sentry SDK's module, as createErrorTracker loads it. */
export type SentrySdk = typeof import('@sentry/node');

export interface ErrorTrackerOptions {
  /** SENTRY_DSN; empty means off. */
  dsn: string;
  /** The image's full git sha (BUILD_INFO.sha); unknown in development. */
  release: string | undefined;
  /** NODE_ENV: production, development or test. */
  environment: string;
  /** Context ErrorTracking: the tracker's own troubles (Bugsink unreachable). */
  logger: Logger;
  /** How the SDK is loaded; a spec's stand-in proves when it is not. */
  loadSdk?: () => Promise<SentrySdk>;
}

const CLOSE_TIMEOUT_MS = 2_000;

/**
 * The app's tracker. The SDK is imported here, after the DSN check, so a
 * process without one (development, the tests, CI, a production without
 * Bugsink) never evaluates Sentry's or OpenTelemetry's modules.
 */
export async function createErrorTracker({
  dsn,
  release,
  environment,
  logger,
  loadSdk = () => import('@sentry/node'),
}: ErrorTrackerOptions): Promise<ErrorTracker> {
  if (!dsn) return DISABLED_ERROR_TRACKER;

  const {
    contextLinesIntegration,
    dedupeIntegration,
    defaultStackParser,
    linkedErrorsIntegration,
    makeNodeTransport,
    NodeClient,
    nodeContextIntegration,
    Scope: SentryScope,
  } = await loadSdk();
  const client = new NodeClient({
    dsn,
    release,
    environment,
    // Errors only, every one of them; no tracing, no sessions, no client
    // reports. Bugsink supports none of the rest (finplat's settings).
    sampleRate: 1,
    sendDefaultPii: false,
    sendClientReports: false,
    maxBreadcrumbs: 0,
    stackParser: defaultStackParser,
    transport: (options) => {
      const transport = makeNodeTransport(options);
      return {
        ...transport,
        send: async (envelope) => {
          try {
            const response = await transport.send(envelope);
            const status = response.statusCode ?? 0;
            if (status >= 400) {
              logger.warn(`Bugsink refused an event: HTTP ${status}`);
            }
            return response;
          } catch (error) {
            logger.warn(
              `Could not send an event to Bugsink: ${error instanceof Error ? error.message : String(error)}`,
            );
            throw error;
          }
        },
      };
    },
    integrations: [
      dedupeIntegration(),
      linkedErrorsIntegration(),
      nodeContextIntegration(),
      contextLinesIntegration(),
    ],
    beforeSend: scrubEvent,
  });
  const base = new SentryScope();
  base.setClient(client);
  client.init();

  function scopeFor({ source, tags, userId }: ErrorContext): Scope {
    const scope = base.clone();
    scope.setTags({ source, ...tags });
    if (userId !== undefined) scope.setUser({ id: String(userId) });
    return scope;
  }

  return {
    enabled: true,
    captureException(error, context) {
      // Through the scope, not the client: it hands the integrations the
      // original error (linkedErrors follows its `cause`, where Drizzle keeps
      // Postgres's own error).
      scopeFor(context).captureException(error);
    },
    captureClientError(
      { message, stack, route, release: pageRelease },
      userId,
    ) {
      // The page's stack as it sent it: the Node parser reads Chromium's
      // frames; Safari's and Firefox's stay whole in the `client` context.
      const error = new Error(message);
      error.name = 'ClientError';
      error.stack = stack ?? '';
      const scope = scopeFor({
        source: 'client',
        tags: {
          route: route ?? 'unknown',
          ...(pageRelease && { page_release: pageRelease }),
        },
        userId,
      });
      if (stack) scope.setContext('client', { stack });
      scope.captureException(error);
    },
    async flush(timeoutMs) {
      await client.flush(timeoutMs);
    },
    async close(timeoutMs = CLOSE_TIMEOUT_MS) {
      await client.close(timeoutMs);
    },
  };
}

/** How long a crash waits for its event to reach Bugsink before exiting. */
export const CRASH_FLUSH_TIMEOUT_MS = 2_000;

export interface CrashHandlerOptions {
  errors: ErrorTracker;
  /** The process's root logger. */
  logger: Logger;
  /** process.exit; a spec's stand-in. */
  exit: (code: number) => void;
  flushTimeoutMs?: number;
}

/**
 * main.ts's `uncaughtException` listener (production only: the specs'
 * processes keep Node's default). It reports the crash to Bugsink and then
 * crashes as Node would have: logged, exit code 1, so Docker restarts the
 * container. An unhandled rejection arrives here too (origin
 * `unhandledRejection`): with Node's default `--unhandled-rejections=throw`
 * and no `unhandledRejection` listener, Node raises it as an uncaught
 * exception. A listener for that event would swallow it instead, so there
 * is none. A second crash while the first is being sent exits at once.
 */
export function createCrashHandler({
  errors,
  logger,
  exit,
  flushTimeoutMs = CRASH_FLUSH_TIMEOUT_MS,
}: CrashHandlerOptions): (
  error: unknown,
  origin: NodeJS.UncaughtExceptionOrigin,
) => Promise<void> {
  let crashing = false;
  return async (error, origin) => {
    if (crashing) {
      exit(1);
      return;
    }
    crashing = true;
    logger.fatal({ err: error }, `Crashed (${origin}); exiting`);
    try {
      errors.captureException(error, {
        source: 'process',
        tags: { origin },
      });
      await errors.flush(flushTimeoutMs);
    } catch (trackerError) {
      // The crash is already logged; exit whatever the tracker did.
      logger.warn(
        { err: trackerError },
        'Could not send the crash to the error tracker',
      );
    }
    exit(1);
  };
}

const FILTERED = '[Filtered]';

// Keys whose value is a credential wherever they appear in an event (a
// header, a context, an error's property), matched lowercased.
const SECRET_KEYS = new Set([
  'cookie',
  'cookies',
  'set-cookie',
  'authorization',
  'proxy-authorization',
  SESSION_COOKIE,
  'password',
  'currentpassword',
  'newpassword',
  'confirmpassword',
  'token',
  'secret',
  // The order mail's Fastmail API token (#25), by its config key.
  'order_mail_jmap_token',
]);

// Credentials inside any string of an event (an error message, a stack's
// context, a client report). Closet leaked session JWTs to Loki once
// (docs/audits/2026-09-25-closet-stack-and-backups.md): the session token is
// a JWT, so every JWT goes, whatever carried it.
const SECRET_PATTERNS: [RegExp, string][] = [
  [/eyJ[\w-]*\.[\w-]+\.[\w-]*/g, FILTERED],
  [
    new RegExp(`\\b${SESSION_COOKIE}=[^;\\s"']*`, 'g'),
    `${SESSION_COOKIE}=${FILTERED}`,
  ],
  [new RegExp(`\\b${TOKEN_PREFIX}[\\w-]+`, 'g'), `${TOKEN_PREFIX}${FILTERED}`],
  [/\bBearer\s+[^\s"']+/gi, `Bearer ${FILTERED}`],
  // Fastmail API tokens (the order mail's, #25): `fmu1-` and hex groups.
  [/\bfm[a-z]\d-[\w-]+/gi, FILTERED],
  // Drizzle's failed-query message ends with the query's parameters: what
  // a user sent (an email, a hash, a note), never needed to group an error.
  [/\nparams: [\s\S]*$/, `\nparams: ${FILTERED}`],
];

function scrubString(value: string): string {
  return SECRET_PATTERNS.reduce(
    (scrubbed, [pattern, replacement]) =>
      scrubbed.replace(pattern, replacement),
    value,
  );
}

function scrubValue(value: unknown): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        SECRET_KEYS.has(key.toLowerCase()) ? FILTERED : scrubValue(inner),
      ]),
    );
  }
  return value;
}

/**
 * The tracker's beforeSend: no event leaves with a cookie, an Authorization
 * header, a session JWT, a personal access token or a request body. Closet
 * never attaches the request (a capture tags its route template), so any
 * `request` is dropped whole, bodies of the auth routes included; every
 * other string and key in the event is scrubbed.
 */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const scrubbed = scrubValue(event) as ErrorEvent;
  delete scrubbed.request;
  return scrubbed;
}
