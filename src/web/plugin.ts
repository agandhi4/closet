import type { FastifyPluginAsync } from 'fastify';
import type { Db } from '../db/client';
import type { FileService } from '../file/file-service.abstract';
import { isStaticPath } from '../static-prefixes';
import { createSessionHook } from './auth/require-session';
import { authRoutes } from './auth/routes';
import type { SessionTokens } from './auth/tokens';
import { calendarRoutes } from './calendar/routes';
import { createErrorHandler } from './errors';
import { loggableUrl } from './loggable-url';
import type { WebLogger } from './logger';
import { shellRoutes } from './shell/routes';
import { sharingRoutes } from './sharing/routes';

/** Config the ported routes read, resolved once by createApp(). */
export interface WebConfig {
  appName: string;
  iconName: string;
  /** APP_TIMEZONE: the household's IANA zone, which decides "today". */
  timeZone: string;
  /** DISABLE_REGISTRATION: the registration routes redirect to the login page. */
  registrationDisabled: boolean;
}

export interface WebOptions {
  config: WebConfig;
  logger: WebLogger;
  db: Db;
  tokens: SessionTokens;
  /** Photo storage, still a Nest provider; account deletion unlinks through it. */
  files: Pick<FileService, 'deleteVariants'>;
}

/**
 * The plain-Fastify side of the app: every ported feature's routes, on the
 * Fastify instance Nest runs on (registered by createApp() before
 * app.init(), so the routes sit beside Nest's). Encapsulated on purpose: the
 * session hook and the error handler below apply to these routes only,
 * never to Nest's, which keep SessionGuard and ErrorViewFilter. The root
 * hooks in createApp() (same-origin check, rate limits, session resolution
 * and page context at preValidation) run before both.
 *
 * Request validation is Fastify's own: each route declares a JSON schema
 * for its body, querystring and params with TypeBox, and the handler's
 * request types are inferred from it (FastifyPluginCallbackTypebox). A
 * request that fails it never reaches the handler: the error handler
 * renders a 400 page with Fastify's message. Both hooks here run at
 * preValidation, before that check, so an anonymous request is sent to log
 * in and a failed validation still has its page context.
 *
 * A ported feature is one more `app.register(<feature>Routes, options)`.
 *
 * Nest middleware never runs here: Nest registers @fastify/middie in
 * app.init(), after this plugin, and a Fastify plugin only inherits the hooks
 * its parent had when it was registered. That includes nestjs-pino's request
 * log, hence the onResponse hook below.
 */
export const webPlugin: FastifyPluginAsync<WebOptions> = async (
  app,
  options,
) => {
  const { logger } = options;
  app.addHook('preValidation', createSessionHook(logger));
  app.setErrorHandler(createErrorHandler(logger));
  // One line per request, as pino-http writes for Nest routes; static paths
  // (the heartbeat, the manifest) stay out of the log there too. Routes with
  // a secret in the path log their pattern (loggableUrl).
  app.addHook('onResponse', async (request, reply) => {
    if (isStaticPath(request.url)) return;
    logger.log(
      `${request.method} ${loggableUrl(request)} ${reply.statusCode} ${reply.elapsedTime.toFixed(1)}ms`,
    );
  });

  await app.register(shellRoutes, options);
  await app.register(calendarRoutes, options);
  await app.register(authRoutes, options);
  await app.register(sharingRoutes, options);
};
