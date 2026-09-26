import { NotFoundException } from '@nestjs/common';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { createErrorHandler, HttpError } from './errors';
import type { WebLogger } from './logger';
import { renderPage } from './render';
import type { ViewContext } from './view-context';

/**
 * The web plugin's error handler on a bare Fastify instance: routes that
 * throw what ported handlers can throw. The ported shell routes cannot fail
 * on request (test/integration/web.spec.ts covers their answers), so the
 * throwing routes here exist only in this spec.
 */

const ctx: ViewContext = {
  appName: 'Closet',
  iconName: 'icon.png',
  siteUrl: 'http://localhost:3000',
  baseUrl: '/boom',
  signupsDisabled: false,
  pwaEnabled: false,
  appVersion: '1.0.0+test',
  appRelease: '1.0.0',
  canonicalUrl: 'http://localhost/boom',
  ogUrl: 'http://localhost/boom',
  ogImage: 'http://localhost/assets/icon.png',
  user: undefined,
};

describe('createErrorHandler', () => {
  let app: FastifyInstance;
  let logger: Record<keyof WebLogger, Mock>;
  let secondRender: unknown;

  beforeEach(async () => {
    logger = { debug: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    app = Fastify();
    // What the root preValidation hook in app.ts does for every non-static
    // request.
    app.decorateReply('locals', undefined);
    app.addHook('preValidation', async (request, reply) => {
      if (request.url !== '/static') reply.locals = ctx;
    });
    app.setErrorHandler(createErrorHandler(logger));
    app.get('/missing', () => {
      throw new HttpError(404);
    });
    app.get('/nest-missing', () => {
      throw new NotFoundException();
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
    expect(res.body).toContain('<h1>Error 404</h1>');
    expect(res.body).toContain('<p>Not Found</p>');
    expect(res.body).toContain('Path: /missing');
    expect(res.body).toContain('class="dock"');
    expect(logger.warn).toHaveBeenCalledWith('GET /missing -> 404: Not Found');
  });

  it('answers a Nest exception from an unported service with its status', async () => {
    const res = await app.inject({ method: 'GET', url: '/nest-missing' });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('<h1>Error 404</h1>');
  });

  it('keeps a Fastify 4xx thrown in the handler, with its message', async () => {
    const res = await app.inject({ method: 'GET', url: '/too-large' });
    expect(res.statusCode).toBe(413);
    expect(res.body).toContain('<h1>Error 413</h1>');
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
    expect(res.body).toContain('<h1>Error 400</h1>');
    expect(res.body).toContain('body/date must match format &quot;date&quot;');
  });

  it('hides the detail of anything else behind a 500, logged with its stack', async () => {
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.body).toContain('<p>Internal server error</p>');
    expect(res.body).not.toContain('10.0.0.5');
    expect(logger.error).toHaveBeenCalledWith(
      'GET /boom -> 500',
      expect.stringContaining('connection refused at 10.0.0.5'),
    );
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
