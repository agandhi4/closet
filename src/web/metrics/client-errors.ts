import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { sessionUserId } from '../auth/require-session';
import type { WebOptions } from '../plugin';
import { CLIENT_ERROR_LIMIT } from '../security/rate-limit';
import { readBeaconBodies } from './beacon';

/**
 * `POST /errors/client` (#117), registered only with SENTRY_DSN: the pages'
 * uncaught script errors and unhandled rejections from public/js/errors.js,
 * forwarded to Bugsink (ErrorTracker.captureClientError, tagged `client`).
 * Session-only (the layout loads the script on signed-in pages), CSRF-checked
 * like every POST, per-user rate-limited (CLIENT_ERROR_LIMIT), capped at
 * CLIENT_ERROR_MAX_BYTES before the body is read, and validated: a route
 * must be a template the app has (anything else is sent as `unknown`, so no
 * URL or id becomes a tag), a release a git sha.
 */

/** A report's largest body: a full message and stack, JSON-escaped, fit. */
export const CLIENT_ERROR_MAX_BYTES = 16 * 1024;
// public/js/errors.js cuts a report to these before sending.
const MAX_MESSAGE = 1000;
const MAX_STACK = 8000;

const ClientErrorBody = Type.Object({
  message: Type.String({ minLength: 1, maxLength: MAX_MESSAGE }),
  stack: Type.Optional(Type.String({ maxLength: MAX_STACK })),
  route: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  release: Type.Optional(Type.String({ pattern: '^[0-9a-f]{7,40}$' })),
});

export const clientErrorRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  { errors, metrics, logger },
  done,
) => {
  readBeaconBodies(app, CLIENT_ERROR_MAX_BYTES);

  app.post(
    '/errors/client',
    {
      bodyLimit: CLIENT_ERROR_MAX_BYTES,
      config: { rateLimit: CLIENT_ERROR_LIMIT },
      schema: { body: ClientErrorBody },
    },
    async (request, reply) => {
      const { message, stack, route, release } = request.body;
      const known = route !== undefined && metrics.hasRoute(route);
      const userId = sessionUserId(request);
      errors.captureClientError(
        { message, stack, route: known ? route : undefined, release },
        userId,
      );
      // Never the message: it is the page's text, not ours.
      logger.info(
        `Client error from user ${userId} on ${known ? route : 'an unknown route'}: sent to the error tracker`,
      );
      return reply.status(204).send();
    },
  );

  done();
};
