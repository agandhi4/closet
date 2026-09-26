import type { AuthContext } from '../web/auth/session';
import type { ViewContext } from '../web/view-context';

declare module 'fastify' {
  interface FastifyRequest {
    /** Session resolved once per request by the preValidation hook in app.ts (createSessionResolver, src/web/auth/session.ts). Undefined on static paths and for anonymous requests; SessionGuard and requireSession guarantee it on every protected route. Read through @UserId() (Nest) or sessionUserId() (web layer). */
    auth?: AuthContext;
  }

  interface FastifyReply {
    /** Page context built per request by ViewContextService; absent only on static paths. JSX pages read it through viewContext(reply). */
    locals?: ViewContext;
    // @fastify/view's type definitions don't support custom propertyName values.
    // Required workaround for the viewPartial renderer registered without a global
    // layout in src/app.ts. Remove when the upstream issue is resolved.
    // https://github.com/fastify/point-of-view/issues/301
    viewPartial(page: string, data?: Record<string, unknown>): FastifyReply;
    viewPartialAsync(
      page: string,
      data?: Record<string, unknown>,
    ): Promise<string>;
  }
}
