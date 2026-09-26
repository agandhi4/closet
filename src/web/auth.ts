import type { FastifyReply, FastifyRequest } from 'fastify';
import { decideSessionAccess, LOGIN_PATH } from '../auth/session-access';
import type { WebLogger } from './logger';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * Reachable without a session (login, the manifest, the about page).
     * Plain-Fastify routes are protected unless they say `config: { public:
     * true }`, as Nest routes are unless they are @Public().
     */
    public?: boolean;
  }
}

/**
 * The session gate for plain-Fastify routes, a preHandler in the web plugin's
 * scope. It runs after the root preHandler in app.ts has resolved `req.auth`
 * and answers exactly as SessionGuard + ErrorViewFilter do for Nest routes
 * (the decision is shared: decideSessionAccess): a page navigation without a
 * session is a 302 to the login page, an htmx fragment or fetch a bodiless
 * 401 with `HX-Redirect`. Both are routine, so they log at debug.
 */
export function createSessionHook(logger: WebLogger) {
  return async function requireSession(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | undefined> {
    const isPublic = request.routeOptions.config.public === true;
    // Answering from an async hook means returning the reply: Fastify then
    // skips the handler.
    switch (decideSessionAccess(request, isPublic)) {
      case 'allow':
        return;
      case 'redirect-to-login':
        logger.debug(`${request.url} -> ${LOGIN_PATH}`);
        return reply.redirect(LOGIN_PATH, 302);
      case 'login-required':
        logger.debug(`${request.url} -> 401, HX-Redirect ${LOGIN_PATH}`);
        return reply.status(401).header('HX-Redirect', LOGIN_PATH).send();
    }
  };
}
