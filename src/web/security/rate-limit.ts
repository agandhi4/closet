import fastifyRateLimit, { type RateLimitOptions } from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { loggableUrl } from '../loggable-url';
import type { Logger } from '../../logger';

/**
 * Brute-force limits for the routes that check a password, and a ceiling on
 * the routes that fetch a user's URL and on the MCP endpoint. Registered
 * once at the root by createApp() with `global: false`: nothing is limited
 * unless its route opts in with `config: { rateLimit: SIGN_IN_LIMIT }` (or
 * ACCOUNT_LIMIT, LINK_IMPORT_LIMIT, MCP_LIMIT). Every limited route counts
 * on its own. Counters live in
 * process memory, which is right for the single container this runs as.
 *
 * The client address is `request.ip`, which Fastify takes from
 * X-Forwarded-For only when the peer is in TRUSTED_PROXIES. Behind Caddy,
 * TRUSTED_PROXIES must include Caddy's address, or every visitor shares
 * Caddy's IP and one person's typos lock out the household (CLAUDE.md,
 * Deployment).
 */
export async function registerRateLimit(
  fastify: FastifyInstance,
  logger: Logger,
): Promise<void> {
  await fastify.register(fastifyRateLimit, {
    global: false,
    // An HttpError, so the web layer's error handler renders it as a page
    // with its status and message like any other refusal.
    errorResponseBuilder: (_request, context) =>
      new HttpError(
        context.statusCode,
        t('TOO_MANY_ATTEMPTS', { after: context.after }),
      ),
    onExceeded: (request: FastifyRequest, key: string) => {
      logger.warn(
        `Rate limit reached: ${request.method} ${loggableUrl(request)} for ${key}`,
      );
    },
  });
}

/** Login and registration: per client address, before the body is read. */
export const SIGN_IN_LIMIT: RateLimitOptions = {
  max: 5,
  timeWindow: '1 minute',
};

/**
 * Every route that checks the current password: change password, change
 * email, delete account and creating a personal access token (src/web/auth/
 * token-routes.tsx). Per signed-in user, whatever address
 * they come from. A preHandler, so it runs after the session gate (the web
 * plugin's own preHandler) has guaranteed `request.auth`; an anonymous
 * request is answered by the gate and never counted.
 */
export const ACCOUNT_LIMIT: RateLimitOptions = {
  max: 5,
  timeWindow: '1 minute',
  hook: 'preHandler',
  keyGenerator: (request) => `user ${request.auth!.user.id}`,
};

/**
 * The routes that fetch a URL the user supplied through the outbound
 * fetcher (the link import and its photo choice; one import fetches the
 * page and up to MAX_PHOTO_CHOICES images). Per signed-in user, like
 * ACCOUNT_LIMIT: generous for someone adding what they bought, and a
 * ceiling on how hard the server can be made to hammer another site.
 */
export const LINK_IMPORT_LIMIT: RateLimitOptions = {
  max: 10,
  timeWindow: '1 minute',
  hook: 'preHandler',
  keyGenerator: (request) => `user ${request.auth!.user.id}`,
};

/**
 * The MCP endpoint (src/web/mcp): per personal access token, a preHandler
 * after the endpoint's own hook has authenticated it (an unauthenticated
 * call is a 401 there and never counted). An agent calls tools in bursts;
 * this is room for a busy conversation and a ceiling on a runaway loop.
 */
export const MCP_LIMIT: RateLimitOptions = {
  max: 120,
  timeWindow: '1 minute',
  hook: 'preHandler',
  keyGenerator: (request) => `token ${request.accessToken!.tokenId}`,
};

/**
 * The MCP tool that imports a link (add_garment_from_link) fetches a
 * stranger's site like the link import's routes, so it gets their budget,
 * per user, through `createRateLimit` (it is one call among many to the
 * same endpoint, not a route of its own).
 */
export const MCP_LINK_IMPORT_LIMIT = {
  max: 10,
  timeWindow: '1 minute',
  keyGenerator: (request: FastifyRequest) =>
    `user ${request.accessToken!.user.id}`,
};
