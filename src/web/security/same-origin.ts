import type {
  FastifyReply,
  FastifyRequest,
  onRequestAsyncHookHandler,
} from 'fastify';
import type { IncomingHttpHeaders } from 'node:http';
import { loggableUrl } from '../loggable-url';
import { sendProblem } from '../errors';
import { surfaceOf } from '../surface';
import type { Logger } from '../../logger';
import { originOf, requestOrigin } from './origin';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CROSS_ORIGIN_REFUSED = 'Cross-origin request refused';

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
 * CSRF protection for every route: a root onRequest hook that createApp()
 * adds before any route is registered, so it runs ahead of all of them,
 * before the body is read. A
 * state-changing request must name, in Origin (or Referer when Origin is
 * absent), either the origin it was sent to (requestOrigin: the Host as
 * Fastify trusts it) or SITE_URL's origin (the canonical https name, which a
 * proxy missing from TRUSTED_PROXIES reports as plain http). Anything else,
 * including neither header, is a 403; only a bearer surface (/mcp, /api)
 * accepts neither header.
 *
 * The session cookie is SameSite=Lax as well (session-cookie.ts); this
 * check does not depend on the browser's cookie policy, and it covers the
 * routes that need no session (login and registration are CSRF targets too).
 */
export function createSameOriginHook(options: {
  siteUrl: string;
  logger: Logger;
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
    // A bearer surface (/mcp, /api: the route's config, or the not-found
    // config of an unmatched /api path, surfaceOf) is called by programs,
    // which send no Origin. The cookie is never read there and a page cannot
    // attach the Authorization header cross-site without a CORS preflight,
    // which is never answered, so an absent Origin is no CSRF. A present
    // foreign one is still refused: the MCP spec's defence against DNS
    // rebinding.
    const surface = surfaceOf(request);
    if (claimed === undefined && surface !== 'page') return;
    logger.warn(
      `Refused ${request.method} ${loggableUrl(request)} from origin ${claimed ?? 'none'} (accepts ${own} and ${siteOrigin ?? 'no SITE_URL'})`,
    );
    if (surface === 'api') {
      return sendProblem(request, reply, {
        status: 403,
        message: CROSS_ORIGIN_REFUSED,
        code: 'forbidden',
      });
    }
    return reply
      .status(403)
      .type('text/plain; charset=utf-8')
      .send(CROSS_ORIGIN_REFUSED);
  };
}
