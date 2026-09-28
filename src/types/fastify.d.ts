import type { RequestTiming } from '../metrics/request-timing';
import type { TokenAuth } from '../web/auth/personal-tokens';
import type { AuthContext } from '../web/auth/session';
import type { ViewContext } from '../web/view-context';

declare module 'fastify' {
  interface FastifyRequest {
    /** Session resolved once per request by the preValidation hook in app.ts (createSessionResolver, src/web/auth/session.ts). Undefined on static paths and for anonymous requests; requireSession guarantees it on every protected route. Read through sessionUserId(). */
    auth?: AuthContext;
    /** The personal access token a bearer route (config.bearer: the MCP endpoint) was called with, set by that route's own preValidation hook (src/web/mcp/routes.ts), which refuses every request without one. Never set from a cookie. */
    accessToken?: TokenAuth;
    /** Where this request's server time went (Server-Timing): set by the first onRequest hook (registerHttpMetrics, src/metrics/http.ts). Absent only on a request Fastify answered before its hooks (a malformed URL). */
    timing?: RequestTiming;
  }

  interface FastifyReply {
    /** Page context built per request by the root preValidation hook (createViewContextBuilder); absent only on static paths. JSX pages read it through viewContext(reply). */
    locals?: ViewContext;
  }
}
