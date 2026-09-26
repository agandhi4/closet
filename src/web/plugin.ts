import type { FastifyPluginAsync } from 'fastify';
import { isStaticPath } from '../static-prefixes';
import { createSessionHook } from './auth';
import { createErrorHandler } from './errors';
import type { WebLogger } from './logger';
import { shellRoutes } from './shell/routes';

/** Config the ported routes read, resolved once by createApp(). */
export interface WebConfig {
  appName: string;
  iconName: string;
}

export interface WebOptions {
  config: WebConfig;
  logger: WebLogger;
}

/**
 * The plain-Fastify side of the app: every ported feature's routes, on the
 * Fastify instance Nest runs on (registered by createApp() before
 * app.init(), so the routes sit beside Nest's). Encapsulated on purpose: the
 * session hook and the error handler below apply to these routes only,
 * never to Nest's, which keep SessionGuard and ErrorViewFilter. The root
 * preHandler in app.ts (req.auth, reply.locals) runs before both.
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
  app.addHook('preHandler', createSessionHook(logger));
  app.setErrorHandler(createErrorHandler(logger));
  // One line per request, as pino-http writes for Nest routes; static paths
  // (the heartbeat, the manifest) stay out of the log there too.
  app.addHook('onResponse', async (request, reply) => {
    if (isStaticPath(request.url)) return;
    logger.log(
      `${request.method} ${request.url} ${reply.statusCode} ${reply.elapsedTime.toFixed(1)}ms`,
    );
  });

  await app.register(shellRoutes, options);
};
