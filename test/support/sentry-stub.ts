import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';
import type {
  ClientErrorReport,
  ErrorContext,
  ErrorTracker,
} from '../../src/metrics/error-tracker';

/**
 * Bugsink's stand-in for the specs (#117): a local HTTP server at a DSN
 * that the real Sentry transport posts its envelopes to, so a spec sees
 * exactly what would leave the process, and no spec reaches a real
 * tracker. `bodies` is every envelope as sent (decompressed), for scanning
 * for secrets; `events` the error events in them.
 */

/** The parts of a Sentry event the specs read. */
export interface SentryEvent {
  release?: string;
  environment?: string;
  tags?: Record<string, string>;
  user?: { id?: string };
  contexts?: Record<string, Record<string, unknown>>;
  request?: unknown;
  exception?: {
    values?: {
      type?: string;
      value?: string;
      stacktrace?: { frames?: { filename?: string; function?: string }[] };
    }[];
  };
}

export interface SentryStub {
  dsn: string;
  bodies: string[];
  events: SentryEvent[];
  /** Resolves once `count` events have arrived (5 s at most). */
  waitForEvents(count: number): Promise<SentryEvent[]>;
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks);
  return (
    request.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw
  ).toString('utf8');
}

// An envelope is newline-delimited JSON: its header, then a header and a
// payload per item.
function eventsIn(envelope: string): SentryEvent[] {
  const lines = envelope.split('\n').filter(Boolean);
  const events: SentryEvent[] = [];
  for (let index = 1; index + 1 < lines.length; index += 2) {
    const { type } = JSON.parse(lines[index]) as { type: string };
    if (type === 'event') {
      events.push(JSON.parse(lines[index + 1]) as SentryEvent);
    }
  }
  return events;
}

/**
 * `port` 0 (the integration specs) takes a free one; Playwright's is fixed
 * (SENTRY_STUB_PORT), because the server's DSN is set before it boots.
 */
export async function startSentryStub(port = 0): Promise<SentryStub> {
  const bodies: string[] = [];
  const events: SentryEvent[] = [];
  const server = createServer((request, response) => {
    readBody(request)
      .then((body) => {
        bodies.push(body);
        events.push(...eventsIn(body));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
      })
      .catch(() => {
        response.writeHead(400);
        response.end();
      });
  });
  await new Promise<void>((resolve, reject) =>
    server.once('error', reject).listen(port, '127.0.0.1', () => resolve()),
  );
  const { port: listening } = server.address() as AddressInfo;
  return {
    dsn: `http://publickey@127.0.0.1:${listening}/1`,
    bodies,
    events,
    async waitForEvents(count) {
      const deadline = Date.now() + 5_000;
      while (events.length < count) {
        if (Date.now() > deadline) {
          throw new Error(
            `Expected ${count} event(s) at the Sentry stub, got ${events.length}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return events;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

/** What a unit spec's tracker was handed, without Sentry. */
export interface RecordedErrors {
  tracker: ErrorTracker;
  exceptions: { error: unknown; context: ErrorContext }[];
  clientErrors: { report: ClientErrorReport; userId: number }[];
}

export function recordErrors(): RecordedErrors {
  const exceptions: RecordedErrors['exceptions'] = [];
  const clientErrors: RecordedErrors['clientErrors'] = [];
  return {
    tracker: {
      enabled: true,
      captureException(error, context) {
        exceptions.push({ error, context });
      },
      captureClientError(report, userId) {
        clientErrors.push({ report, userId });
      },
      flush: () => Promise.resolve(),
      close: () => Promise.resolve(),
    },
    exceptions,
    clientErrors,
  };
}
