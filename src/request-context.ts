import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
// Type only: request-timing.ts reads its timing through currentRequest().
import type { RequestTiming } from './metrics/request-timing';

/**
 * What code running for a request or a background job can know without
 * being handed it: the operation's id (and a request's timing). Carried in
 * async context because the readers run far from where the operation
 * started: every logger line (src/logger.ts, pino's mixin), the error
 * tracker's tags (src/metrics/error-tracker.ts), the pool and the renderer
 * (src/metrics/request-timing.ts). One store for both kinds: a job started
 * while a request runs replaces it, keeping its id as `parentRequestId`, so
 * a line is the request's or the job's, never both. Outside either (boot,
 * the CLIs) there is none.
 */
export interface RequestContext {
  readonly kind: 'request';
  /** 12 lowercase hex (newRequestId); the X-Request-ID response header. */
  readonly requestId: string;
  readonly timing: RequestTiming;
}

/**
 * The kinds of background work (the `<kind>-` of a job id): `cron`, one run
 * of a timer server.ts starts (src/maintenance/scheduled.ts); `cutout`, one
 * photo through the background-removal queue (src/cutout/queue.ts).
 */
export type JobKind = 'cron' | 'cutout';

export interface JobContext {
  readonly kind: 'job';
  /** `<kind>-<12 hex>`, fresh per run (newJobId): the `job_id` log field. */
  readonly jobId: string;
  /** The request that asked for this work, when one did. */
  readonly parentRequestId?: string;
}

type OperationContext = RequestContext | JobContext;

const storage = new AsyncLocalStorage<OperationContext>();

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

/** A job's id: its kind, then 12 lowercase hex like a request's (observability.md). */
export function newJobId(kind: JobKind): string {
  return `${kind}-${newRequestId()}`;
}

/** The request this code runs for, if any. */
export function currentRequest(): RequestContext | undefined {
  const context = storage.getStore();
  return context?.kind === 'request' ? context : undefined;
}

/** The job this code runs for, if any. */
export function currentJob(): JobContext | undefined {
  const context = storage.getStore();
  return context?.kind === 'job' ? context : undefined;
}

/**
 * Runs `work` as one job of `kind`, under a fresh id: every line it logs
 * carries `job_id` (and `parent_request_id`), every error it reports the
 * same tags. The parent is the request running now unless the caller names
 * the one that asked (the cutout queue reads it from the photo's row).
 */
export function runAsJob<T>(
  kind: JobKind,
  work: () => Promise<T>,
  { parentRequestId }: { parentRequestId?: string } = {
    parentRequestId: currentRequest()?.requestId,
  },
): Promise<T> {
  return storage.run(
    {
      kind: 'job',
      jobId: newJobId(kind),
      ...(parentRequestId && { parentRequestId }),
    },
    work,
  );
}

/**
 * The fields naming the operation a line or an error belongs to: a
 * request's `request_id`, or a job's `job_id` and `parent_request_id`. The
 * logger's mixin and the error tracker's tags both read this.
 */
export function operationFields(): Record<string, string> {
  const context = storage.getStore();
  if (context?.kind === 'request') return { request_id: context.requestId };
  if (context?.kind === 'job') {
    return {
      job_id: context.jobId,
      ...(context.parentRequestId && {
        parent_request_id: context.parentRequestId,
      }),
    };
  }
  return {};
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
      kind: 'request',
      requestId: request.id,
      timing: { dbMs: 0, dbStatements: 0, renderMs: 0, secretChecked: false },
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
