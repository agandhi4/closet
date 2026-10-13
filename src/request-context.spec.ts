import Fastify from 'fastify';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { LogCapture } from '../test/support/log-capture';
import { createLoggerTo } from './logger';
import {
  currentJob,
  currentRequest,
  newJobId,
  newRequestId,
  REQUEST_ID_HEADER,
  registerRequestContext,
  runAsJob,
} from './request-context';

const HEX12 = /^[0-9a-f]{12}$/;

/**
 * createApp's id options and hooks on a bare instance, with a module-level
 * logger as the app's modules have one: its lines must carry the request's
 * id without being handed the request.
 */
async function appWithContext() {
  const logs = new LogCapture();
  const module = createLoggerTo('info', logs).child({ logger: 'Module' });
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
  // A job a request starts: its lines carry the job's id, and the request's
  // as the parent, never the request's own request_id.
  app.get('/starts-job', async () => {
    const jobId = await runAsJob('cutout', () => {
      module.info('in the job');
      return Promise.resolve(currentJob()?.jobId);
    });
    module.info('back in the request');
    return { id: currentRequest()?.requestId, jobId };
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

describe('newJobId', () => {
  it('is the kind, then 12 lowercase hex, fresh every time', () => {
    const ids = new Set(Array.from({ length: 100 }, () => newJobId('cron')));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id).toMatch(/^cron-[0-9a-f]{12}$/);
  });
});

describe('runAsJob', () => {
  it("puts a fresh job_id on every line of each run, and no request's id", async () => {
    const logs = new LogCapture();
    const module = createLoggerTo('info', logs).child({ logger: 'Module' });
    const run = () =>
      runAsJob('cron', async () => {
        await sleep(1);
        module.info('in the job');
        expect(currentRequest()).toBeUndefined();
      });
    await run();
    await run();
    const [first, second] = logs.records;
    expect(first.job_id).toMatch(/^cron-[0-9a-f]{12}$/);
    expect(second.job_id).toMatch(/^cron-[0-9a-f]{12}$/);
    expect(first.job_id).not.toBe(second.job_id);
    for (const record of logs.records) {
      expect(record).not.toHaveProperty('request_id');
      expect(record).not.toHaveProperty('parent_request_id');
    }
    expect(currentJob()).toBeUndefined();
  });

  it('names the request that started it as parent_request_id', async () => {
    const { app, logs } = await appWithContext();
    const res = await app.inject({ method: 'GET', url: '/starts-job' });
    const { id, jobId } = res.json<{ id: string; jobId: string }>();
    expect(jobId).toMatch(/^cutout-[0-9a-f]{12}$/);
    expect(logs.records).toEqual([
      expect.objectContaining({
        msg: 'in the job',
        job_id: jobId,
        parent_request_id: id,
      }),
      expect.objectContaining({ msg: 'back in the request', request_id: id }),
    ]);
    expect(logs.records[0]).not.toHaveProperty('request_id');
  });

  it('takes the parent the caller names (a queued row records its request)', async () => {
    const logs = new LogCapture();
    const module = createLoggerTo('info', logs);
    await runAsJob(
      'cutout',
      () => Promise.resolve(module.info('queued earlier')),
      { parentRequestId: '0123456789ab' },
    );
    expect(logs.records[0]).toMatchObject({
      parent_request_id: '0123456789ab',
    });
  });
});
