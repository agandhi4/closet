import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureLogs, type LogCapture } from '../../test/support/log-capture';
import {
  recordErrors,
  type RecordedErrors,
} from '../../test/support/sentry-stub';
import { createErrorHandler, HttpError } from './errors';
import { renderPage } from './render';
import type { ViewContext } from './view-context';

/**
 * The app's error handler on a bare Fastify instance: routes that
 * throw what ported handlers can throw. The ported shell routes cannot fail
 * on request (test/integration/web.spec.ts covers their answers), so the
 * throwing routes here exist only in this spec.
 */

const ctx: ViewContext = {
  appName: 'Closet',
  iconName: 'icon.png',
  siteUrl: 'http://localhost:3000',
  path: '/boom',
  signupsDisabled: false,
  pwaEnabled: false,
  weatherEnabled: false,
  metricsEnabled: false,
  errorTrackingEnabled: false,
  buildSha: undefined,
  appVersion: '1.0.0+test',
  appRelease: '1.0.0',
  canonicalUrl: 'http://localhost/boom',
  ogUrl: 'http://localhost/boom',
  ogImage: 'http://localhost/assets/icon.png',
  user: undefined,
};

describe('createErrorHandler', () => {
  let app: FastifyInstance;
  let logs: LogCapture;
  let errors: RecordedErrors;
  let secondRender: unknown;

  beforeEach(async () => {
    const captured = captureLogs();
    logs = captured.logs;
    errors = recordErrors();
    app = Fastify();
    // What the root preValidation hook in app.ts does for every non-static
    // request.
    app.decorateReply('locals', undefined);
    app.addHook('preValidation', async (request, reply) => {
      if (request.url !== '/static') reply.locals = ctx;
    });
    app.setErrorHandler(createErrorHandler(captured.logger, errors.tracker));
    app.get('/missing', () => {
      throw new HttpError(404);
    });
    app.get('/busy', () => {
      throw new HttpError(503, 'Try again in a moment.', {
        logDetail: 'owner 7',
      });
    });
    app.get('/boom', () => {
      throw new Error('connection refused at 10.0.0.5');
    });
    // A multipart part over the size limit fails inside the handler.
    app.get('/too-large', () => {
      throw Object.assign(new Error('request file too large'), {
        statusCode: 413,
      });
    });
    app.post('/json', () => 'unreachable');
    // As a ported route declares its input (src/web/plugin.ts, Validation).
    app.post(
      '/validated',
      {
        schema: {
          body: {
            type: 'object',
            required: ['date'],
            properties: { date: { type: 'string', format: 'date' } },
          },
        },
      },
      () => 'unreachable',
    );
    app.get('/static', () => {
      throw new Error('boom');
    });
    app.get('/twice', async (_request, reply) => {
      await renderPage(reply, <p>first</p>);
      secondRender = await renderPage(reply, <p>second</p>).catch(
        (error: Error) => error.message,
      );
      return reply;
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('renders the error page with the thrown status', async () => {
    const res = await app.inject({ method: 'GET', url: '/missing' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.body).toMatch(/^<!DOCTYPE html><html lang="en">/);
    expect(res.body).toMatch(/<h1\b[^>]*>Error 404<\/h1>/);
    expect(res.body).toContain('<p>Not Found</p>');
    expect(res.body).toContain('Path: /missing');
    expect(res.body).toContain('class="dock"');
    expect(logs.messages('warn')).toEqual(['GET /missing -> 404: Not Found']);
  });

  it('keeps a Fastify 4xx thrown in the handler, with its message', async () => {
    const res = await app.inject({ method: 'GET', url: '/too-large' });
    expect(res.statusCode).toBe(413);
    expect(res.body).toMatch(/<h1\b[^>]*>Error 413<\/h1>/);
    expect(res.body).toContain('<p>request file too large</p>');
  });

  // Body parsing runs before the root preValidation hook, so there is no page
  // context yet: the status is kept and the answer is data.
  it('answers an unparsable body with a 400 before any page context exists', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/json',
      headers: { 'content-type': 'application/json' },
      payload: '{',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ statusCode: 400 });
  });

  // Validation runs after the root preValidation hook: the page context
  // exists, so a malformed input gets the error page.
  it('renders a failed schema validation as the 400 error page', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/validated',
      payload: { date: 'garbage' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/^<!DOCTYPE html>/);
    expect(res.body).toMatch(/<h1\b[^>]*>Error 400<\/h1>/);
    expect(res.body).toContain('body/date must match format &quot;date&quot;');
  });

  it('keeps a chosen 5xx HttpError, logged as a warning with its log detail', async () => {
    const res = await app.inject({ method: 'GET', url: '/busy' });
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain('<p>Try again in a moment.</p>');
    expect(res.body).not.toContain('owner 7');
    expect(logs.messages('warn')).toEqual([
      'GET /busy -> 503: Try again in a moment. (owner 7)',
    ]);
    expect(logs.records.some((record) => record.level === 'error')).toBe(false);
  });

  // #117: the error tracker gets crashes, never an answer the code chose.
  // The owner lock's 503 is contention working as designed (errors.tsx).
  it('sends only the unexpected 500 to the error tracker', async () => {
    for (const url of ['/missing', '/busy', '/too-large']) {
      await app.inject({ method: 'GET', url });
    }
    await app.inject({ method: 'POST', url: '/validated', payload: {} });
    expect(errors.exceptions).toEqual([]);

    await app.inject({ method: 'GET', url: '/boom' });
    expect(errors.exceptions).toHaveLength(1);
    const [{ error, context }] = errors.exceptions;
    expect((error as Error).message).toBe('connection refused at 10.0.0.5');
    expect(context).toEqual({
      source: 'route',
      tags: { route: '/boom', method: 'GET' },
      userId: undefined,
    });
  });

  it('hides the detail of anything else behind a 500, logged with its stack', async () => {
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.body).toContain('<p>Internal server error</p>');
    expect(res.body).not.toContain('10.0.0.5');
    const [logged] = logs.records.filter((record) => record.level === 'error');
    expect(logged.msg).toBe('GET /boom -> 500');
    expect(logged.err?.stack).toContain('connection refused at 10.0.0.5');
  });

  it('answers data on a path without a page context', async () => {
    const res = await app.inject({ method: 'GET', url: '/static' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      statusCode: 500,
      message: 'Internal server error',
    });
  });

  it('never answers twice', async () => {
    const res = await app.inject({ method: 'GET', url: '/twice' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('<!DOCTYPE html><p>first</p>');
    expect(secondRender).toBe('/twice: reply already sent');
  });
});
