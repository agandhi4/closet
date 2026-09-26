import type { FastifyReply, FastifyRequest } from 'fastify';
import { decideSessionAccess, LOGIN_PATH } from './session-access';
import { loggableUrl } from '../loggable-url';
import type { Logger } from '../../logger';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * Reachable without a session (login, the manifest, the about page).
     * Every route is protected unless it says `config: { public: true }`.
     */
    public?: boolean;
  }
}

/**
 * The session gate, a preValidation hook in the web plugin's scope. It runs
 * after the root hook in app.ts has resolved `req.auth` and before schema
 * validation, so a request without a session is sent to log in rather than
 * told its body is malformed. It answers as decideSessionAccess decides: a
 * page navigation without a session is a 302 to the login page, an htmx
 * fragment or fetch a bodiless 401 with `HX-Redirect`. Both are routine, so
 * they log at debug.
 */
export function createSessionHook(logger: Logger) {
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
        logger.debug(`${loggableUrl(request)} -> ${LOGIN_PATH}`);
        return reply.redirect(LOGIN_PATH, 302);
      case 'login-required':
        logger.debug(
          `${loggableUrl(request)} -> 401, HX-Redirect ${LOGIN_PATH}`,
        );
        return reply.status(401).header('HX-Redirect', LOGIN_PATH).send();
    }
  };
}

/**
 * The signed-in user's id on a protected route, where requireSession has
 * already refused requests without a session.
 * Calling it from a public route is a programming error.
 */
export function sessionUserId(request: FastifyRequest): number {
  if (!request.auth) {
    throw new Error(
      `sessionUserId() on ${request.method} ${loggableUrl(request)}, which has no session: is the route public?`,
    );
  }
  return request.auth.user.id;
}
