import type { ErrorEvent } from '@sentry/node';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { captureLogs } from '../../test/support/log-capture';
import { recordErrors } from '../../test/support/sentry-stub';
import {
  createCrashHandler,
  createErrorTracker,
  DISABLED_ERROR_TRACKER,
  type ErrorTracker,
  scrubEvent,
} from './error-tracker';

const SRC = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.spec\.tsx?$/.test(entry.name)
      ? [path]
      : [];
  });
}

// A session token's shape (header.payload.signature, base64url), and a
// personal access token's (closet_ + 43 base64url characters).
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOjcsInB3ZiI6ImFiY2RlZmdoIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ';
const PAT = 'closet_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbC';

function event(fields: Partial<ErrorEvent>): ErrorEvent {
  return { type: undefined, ...fields };
}

describe('scrubEvent', () => {
  it('drops the request whole: cookies, headers and bodies', () => {
    const scrubbed = scrubEvent(
      event({
        request: {
          url: '/auth/login',
          cookies: { access_token: JWT },
          headers: { cookie: `access_token=${JWT}`, authorization: 'x' },
          data: { email: 'owner@example.com', password: 'Password123!' },
        },
      }),
    );
    expect(scrubbed.request).toBeUndefined();
    expect(JSON.stringify(scrubbed)).not.toContain(JWT);
  });

  it('filters credentials out of every string', () => {
    const scrubbed = scrubEvent(
      event({
        message: `cookie access_token=${JWT}; theme=dark`,
        exception: {
          values: [
            {
              type: 'Error',
              value: `bad token ${JWT} and ${PAT}, Authorization: Bearer ${PAT}`,
            },
            {
              type: 'DrizzleQueryError',
              value:
                'Failed query: select 1 where email = $1\nparams: owner@example.com,$2b$10$hash',
            },
          ],
        },
      }),
    );
    const text = JSON.stringify(scrubbed);
    expect(text).not.toContain(JWT);
    expect(text).not.toContain(PAT.slice('closet_'.length));
    expect(text).not.toContain('owner@example.com');
    expect(scrubbed.message).toBe('cookie access_token=[Filtered]; theme=dark');
    expect(scrubbed.exception?.values?.[1].value).toBe(
      'Failed query: select 1 where email = $1\nparams: [Filtered]',
    );
  });

  it("filters the order mail's Fastmail token, bare or by its config key (#25)", () => {
    const token = 'fmu1-0a1b2c3d-4e5f60718293a4b5c6d7e8f9a0b1c2d3-0-e4f5a6b7';
    const scrubbed = scrubEvent(
      event({
        message: `JMAP refused with ${token}`,
        extra: { ORDER_MAIL_JMAP_TOKEN: token },
      }),
    );
    expect(JSON.stringify(scrubbed)).not.toContain(token.slice('fmu1-'.length));
    expect(scrubbed.message).toBe('JMAP refused with [Filtered]');
    expect(scrubbed.extra).toEqual({ ORDER_MAIL_JMAP_TOKEN: '[Filtered]' });
  });

  it('filters secret keys wherever they are', () => {
    const scrubbed = scrubEvent(
      event({
        contexts: {
          upstream: { headers: { Cookie: 'a=b', Authorization: 'Basic x' } },
        },
        extra: { form: { currentPassword: 'hunter2', note: 'kept' } },
        tags: { route: '/wardrobe/:id' },
      }),
    );
    expect(scrubbed.contexts).toEqual({
      upstream: {
        headers: { Cookie: '[Filtered]', Authorization: '[Filtered]' },
      },
    });
    expect(scrubbed.extra).toEqual({
      form: { currentPassword: '[Filtered]', note: 'kept' },
    });
    expect(scrubbed.tags).toEqual({ route: '/wardrobe/:id' });
  });
});

describe('createErrorTracker', () => {
  const options = {
    release: undefined,
    environment: 'test',
    logger: captureLogs().logger,
  };

  // Every boot without a DSN (development, the tests, CI) must not pay for
  // evaluating Sentry's and OpenTelemetry's modules.
  it('never loads the SDK without a DSN', async () => {
    const loadSdk = vi.fn(() => import('@sentry/node'));
    expect(await createErrorTracker({ ...options, dsn: '', loadSdk })).toBe(
      DISABLED_ERROR_TRACKER,
    );
    expect(loadSdk).not.toHaveBeenCalled();

    const tracker = await createErrorTracker({
      ...options,
      dsn: 'http://key@127.0.0.1:9/1',
      loadSdk,
    });
    expect(tracker.enabled).toBe(true);
    expect(loadSdk).toHaveBeenCalledTimes(1);
    await tracker.close(0);
  });

  // What keeps the loader the only way in: a value import anywhere in
  // src/ would load the SDK at boot whatever the DSN.
  it('is the only module that names @sentry/node, and only for types', () => {
    const importers = sourceFiles(SRC).filter((file) =>
      readFileSync(file, 'utf8').includes("'@sentry/node'"),
    );
    expect(importers.map((file) => relative(SRC, file))).toEqual([
      join('metrics', 'error-tracker.ts'),
    ]);
    const source = readFileSync(importers[0], 'utf8');
    const staticImports = [
      ...source.matchAll(/^import\s+(type\s+)?[^;]*from '@sentry\/node';/gm),
    ];
    expect(staticImports.length).toBeGreaterThan(0);
    expect(staticImports.every((match) => match[1] !== undefined)).toBe(true);
  });
});

describe('createCrashHandler', () => {
  function crashFixture(errors: ErrorTracker = recordErrors().tracker) {
    const { logger, logs } = captureLogs();
    const steps: string[] = [];
    const tracker: ErrorTracker = {
      ...errors,
      captureException(error, context) {
        steps.push('capture');
        errors.captureException(error, context);
      },
      async flush(timeoutMs) {
        steps.push(`flush ${timeoutMs}`);
        await errors.flush(timeoutMs);
      },
    };
    const exit = vi.fn((code: number) => {
      steps.push(`exit ${code}`);
    });
    const onCrash = createCrashHandler({ errors: tracker, logger, exit });
    return { onCrash, exit, steps, logs };
  }

  it('reports the crash, waits for it to be sent, then exits 1 as Node would', async () => {
    const recorded = recordErrors();
    const { onCrash, steps, logs } = crashFixture(recorded.tracker);
    const error = new Error('socket hang up');
    await onCrash(error, 'uncaughtException');
    expect(steps).toEqual(['capture', 'flush 2000', 'exit 1']);
    expect(recorded.exceptions).toEqual([
      {
        error,
        context: { source: 'process', tags: { origin: 'uncaughtException' } },
      },
    ]);
    expect(logs.messages('fatal')).toEqual([
      'Crashed (uncaughtException); exiting',
    ]);
  });

  it('names an unhandled rejection by its origin', async () => {
    const recorded = recordErrors();
    const { onCrash } = crashFixture(recorded.tracker);
    await onCrash(new Error('rejected'), 'unhandledRejection');
    expect(recorded.exceptions[0].context.tags).toEqual({
      origin: 'unhandledRejection',
    });
  });

  it('still exits 1 when the tracker fails', async () => {
    const broken: ErrorTracker = {
      ...recordErrors().tracker,
      flush: () => Promise.reject(new Error('Bugsink unreachable')),
    };
    const { onCrash, exit, logs } = crashFixture(broken);
    await onCrash(new Error('boom'), 'uncaughtException');
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(logs.messages('warn')).toEqual([
      'Could not send the crash to the error tracker',
    ]);
  });

  it('exits at once on a second crash while the first is being sent', async () => {
    let release!: () => void;
    const slow: ErrorTracker = {
      ...recordErrors().tracker,
      flush: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    };
    const { onCrash, steps } = crashFixture(slow);
    const first = onCrash(new Error('first'), 'uncaughtException');
    await onCrash(new Error('second'), 'uncaughtException');
    expect(steps).toEqual(['capture', 'flush 2000', 'exit 1']);
    release();
    await first;
    expect(steps).toEqual(['capture', 'flush 2000', 'exit 1', 'exit 1']);
  });
});
