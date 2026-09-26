import fastifyRateLimit, { type RateLimitOptions } from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { loggableUrl } from '../loggable-url';
import type { WebLogger } from '../logger';

/**
 * Brute-force limits for the routes that check a password. Registered once
 * at the root by createApp() with `global: false`: nothing is limited unless
 * its route opts in with `config: { rateLimit: SIGN_IN_LIMIT }` (or
 * ACCOUNT_LIMIT). Every limited route counts on its own. Counters live in
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
  logger: WebLogger,
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
 * Change password and delete account: per signed-in user, whatever address
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
