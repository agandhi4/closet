import type { FastifyInstance } from 'fastify';
import { isWarmRequest } from '../web/shell/offline-warm';
import type { Metrics } from './metrics';
import {
  newRequestTiming,
  runWithRequestTiming,
  serverTimingHeader,
} from './request-timing';

/** The route label of a request no route matched (the 404 page). */
export const UNMATCHED_ROUTE = 'unmatched';

/**
 * The per-request half of the metrics, on the root instance before anything
 * else (createApp): every route's template is noted as it is registered (the
 * device beacon may name only those), each request carries a RequestTiming
 * in async context, answers with `Server-Timing` (db, render, the route
 * template; not once a secret was checked, markSecretChecked) and lands in
 * http_request_duration_seconds under its route template, never its URL, so
 * ids never become series. A request the service worker made to warm the
 * offline caches (#286: hundreds of renders a day per device, no one
 * waiting) is left out, so the latencies stay a person's.
 *
 * Hooks, not a plugin: added to the root, they apply to every route
 * registered after them (CLAUDE.md Gotchas, plugin inheritance).
 */
export function registerHttpMetrics(
  app: FastifyInstance,
  metrics: Metrics,
): void {
  app.decorateRequest('timing', undefined);
  app.addHook('onRoute', (route) => {
    metrics.addRoute(route.url);
  });
  app.addHook('onRequest', (request, _reply, done) => {
    const timing = newRequestTiming();
    request.timing = timing;
    runWithRequestTiming(timing, done);
  });
  // Again once the body is read: a parser's stream events run in the
  // socket's context, so a POST would reach its handler without the timing.
  // Registered before the session hook, so its queries count as the
  // request's.
  app.addHook('preValidation', (request, _reply, done) => {
    if (request.timing) runWithRequestTiming(request.timing, done);
    else done();
  });
  app.addHook('onSend', (request, reply, payload, done) => {
    if (request.timing && !request.timing.secretChecked) {
      reply.header(
        'Server-Timing',
        serverTimingHeader(request.timing, request.routeOptions.url),
      );
    }
    done(null, payload);
  });
  app.addHook('onResponse', (request, reply, done) => {
    if (isWarmRequest(request.headers)) {
      done();
      return;
    }
    metrics.observeRequest(
      request.routeOptions.url ?? UNMATCHED_ROUTE,
      request.method,
      reply.statusCode,
      reply.elapsedTime / 1000,
    );
    done();
  });
}
