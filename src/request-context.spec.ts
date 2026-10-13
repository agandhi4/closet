import Fastify from 'fastify';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { LogCapture } from '../test/support/log-capture';
import { createLoggerTo } from './logger';
import {
  currentRequest,
  newRequestId,
  REQUEST_ID_HEADER,
  registerRequestContext,
} from './request-context';

const HEX12 = /^[0-9a-f]{12}$/;

/**
 * createApp's id options and hooks on a bare instance, with a module-level
 * logger as the app's modules have one: its lines must carry the request's
 * id without being handed the request.
 */
async function appWithContext() {
  const logs = new LogCapture();
  const module = createLoggerTo('info', logs).child({ context: 'Module' });
  const app = Fastify({ genReqId: newRequestId, requestIdHeader: false });
  registerRequestContext(app);
  app.get('/after-await', async () => {
    await sleep(1);
    module.info('in the handler');
    return { id: currentRequest()?.requestId };
  });
  app.post('/body', () => {
    module.info('after the body');
    return Promise.resolve({ id: currentRequest()?.requestId });
  });
  app.get('/fails', () => {
    throw new Error('boom');
  });
  await app.ready();
  return { app, logs };
}

describe('newRequestId', () => {
  it('is 12 lowercase hex, fresh every time', () => {
    const ids = new Set(Array.from({ length: 100 }, newRequestId));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id).toMatch(HEX12);
  });
});

describe('registerRequestContext', () => {
  it("answers with the request's id and puts it on every line it logs", async () => {
    const { app, logs } = await appWithContext();
    const res = await app.inject({ method: 'GET', url: '/after-await' });
    const id = res.headers[REQUEST_ID_HEADER.toLowerCase()];
    expect(id).toMatch(HEX12);
    expect(res.json()).toEqual({ id });
    expect(logs.records).toEqual([
      expect.objectContaining({ msg: 'in the handler', request_id: id }),
    ]);
  });

  it('keeps the context past a parsed body (the socket runs the parser)', async () => {
    const { app, logs } = await appWithContext();
    const res = await app.inject({
      method: 'POST',
      url: '/body',
      payload: { a: 1 },
    });
    const id = res.headers['x-request-id'];
    expect(res.json()).toEqual({ id });
    expect(logs.records[0]).toMatchObject({ request_id: id });
  });

  it('never takes the id from the client, and gives every request its own', async () => {
    const { app } = await appWithContext();
    const forged = 'aaaaaaaaaaaa';
    const [a, b] = await Promise.all(
      [1, 2].map(() =>
        app.inject({
          method: 'GET',
          url: '/after-await',
          headers: { 'x-request-id': forged },
        }),
      ),
    );
    expect(a.headers['x-request-id']).not.toBe(forged);
    expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
  });

  it('puts the header on error and not-found replies too', async () => {
    const { app } = await appWithContext();
    for (const url of ['/fails', '/nowhere']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.headers['x-request-id']).toMatch(HEX12);
    }
  });

  it('leaves code outside a request without one', () => {
    expect(currentRequest()).toBeUndefined();
  });
});
