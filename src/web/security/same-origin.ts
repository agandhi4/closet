import type {
  FastifyReply,
  FastifyRequest,
  onRequestAsyncHookHandler,
} from 'fastify';
import type { IncomingHttpHeaders } from 'node:http';
import { loggableUrl } from '../loggable-url';
import type { WebLogger } from '../logger';
import { originOf, requestOrigin } from './origin';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The origin a browser says a request comes from: the Origin header, which
 * every current browser sends on POST/PUT/PATCH/DELETE (fetch, XHR and form
 * submissions alike), else the origin of the Referer. Undefined when there
 * is neither, or when Origin is the opaque `null` (sandboxed frames,
 * cross-origin redirects).
 */
function claimedOrigin(headers: IncomingHttpHeaders): string | undefined {
  if (typeof headers.origin === 'string') return originOf(headers.origin);
  if (typeof headers.referer === 'string') return originOf(headers.referer);
  return undefined;
}

/**
 * CSRF protection for every route, Nest's and the web layer's alike: a root
 * onRequest hook that createApp() adds before app.init(), so it runs ahead
 * of every route on the shared Fastify instance, before the body is read. A
 * state-changing request must name, in Origin (or Referer when Origin is
 * absent), either the origin it was sent to (requestOrigin: the Host as
 * Fastify trusts it) or SITE_URL's origin (the canonical https name, which a
 * proxy missing from TRUSTED_PROXIES reports as plain http). Anything else,
 * including neither header, is a 403.
 *
 * The session cookie is SameSite=Lax as well (session-cookie.ts); this
 * check does not depend on the browser's cookie policy, and it covers the
 * routes that need no session (login and registration are CSRF targets too).
 */
export function createSameOriginHook(options: {
  siteUrl: string;
  logger: WebLogger;
}): onRequestAsyncHookHandler {
  const siteOrigin = originOf(options.siteUrl);
  const { logger } = options;
  return async function requireSameOrigin(
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    if (!UNSAFE_METHODS.has(request.method)) return;
    const claimed = claimedOrigin(request.headers);
    const own = requestOrigin(request);
    if (claimed !== undefined && (claimed === own || claimed === siteOrigin)) {
      return;
    }
    logger.warn(
      `Refused ${request.method} ${loggableUrl(request)} from origin ${claimed ?? 'none'} (accepts ${own} and ${siteOrigin ?? 'no SITE_URL'})`,
    );
    return reply
      .status(403)
      .type('text/plain; charset=utf-8')
      .send('Cross-origin request refused');
  };
}
