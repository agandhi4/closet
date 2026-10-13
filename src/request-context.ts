import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
// Type only: request-timing.ts reads its timing through currentRequest().
import type { RequestTiming } from './metrics/request-timing';

/**
 * What code running for a request can know without the request object: its
 * id and its timing. Carried in async context because the readers run far
 * from the request: every logger line (src/logger.ts, pino's mixin), the
 * error tracker's tag (src/metrics/error-tracker.ts), the pool and the
 * renderer (src/metrics/request-timing.ts). Outside a request (the timers,
 * the CLIs) there is none.
 */
export interface RequestContext {
  /** 12 lowercase hex (newRequestId); the X-Request-ID response header. */
  readonly requestId: string;
  readonly timing: RequestTiming;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** The response header carrying the request's id. */
export const REQUEST_ID_HEADER = 'X-Request-ID';

/**
 * A request's id: 12 lowercase hex, the observability convention's shape
 * (one id joins a user's report, a Bugsink issue and the logs). Always
 * minted here, never taken from an inbound header (createApp's genReqId).
 */
export function newRequestId(): string {
  return randomBytes(6).toString('hex');
}

/** The request this code runs for, if any. */
export function currentRequest(): RequestContext | undefined {
  return storage.getStore();
}

/** Runs `next` (a Fastify hook's `done`) and everything it leads to inside `context`. */
function runInRequest(context: RequestContext, next: () => void): void {
  storage.run(context, next);
}

/**
 * The first hooks on the root instance (createApp), so every later hook and
 * every route registered after them runs inside the request's context.
 * request.id is Fastify's, minted by newRequestId (genReqId).
 */
export function registerRequestContext(app: FastifyInstance): void {
  app.decorateRequest('timing', undefined);
  app.decorateRequest('requestContext', undefined);
  app.addHook('onRequest', (request, reply, done) => {
    const context: RequestContext = {
      requestId: request.id,
      timing: { dbMs: 0, renderMs: 0, secretChecked: false },
    };
    request.requestContext = context;
    request.timing = context.timing;
    // Set here, not in onSend: a header set this early is on every reply,
    // the error handler's and the not-found handler's included.
    reply.header(REQUEST_ID_HEADER, request.id);
    runInRequest(context, done);
  });
  // Again once the body is read: a parser's stream events run in the
  // socket's context, so a POST would reach its handler without it.
  app.addHook('preValidation', (request, _reply, done) => {
    if (request.requestContext) runInRequest(request.requestContext, done);
    else done();
  });
}
