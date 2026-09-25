import type { AuthContext } from '../auth/auth-context.service';
import type { Payload } from '../auth/dto/payload.dto';

declare module 'fastify' {
  interface FastifyRequest {
    /** Session resolved once per request by the preHandler hook in main.ts (AuthContextService). Undefined on static paths, when AUTH_ENABLED=false, and for anonymous requests. */
    auth?: AuthContext;
    /** JWT payload set by AuthGuard / ConditionalAuthGuard; read by the @User() decorator. */
    user?: Payload;
  }

  interface FastifyReply {
    /** Template context built per request by ViewContextService; absent only on static paths. */
    locals?: Record<string, any>;
    // @fastify/view's type definitions don't support custom propertyName values.
    // Required workaround for the viewPartial renderer registered without a global
    // layout in src/main.ts. Remove when the upstream issue is resolved.
    // https://github.com/fastify/point-of-view/issues/301
    viewPartial(page: string, data?: Record<string, unknown>): FastifyReply;
    viewPartialAsync(
      page: string,
      data?: Record<string, unknown>,
    ): Promise<string>;
  }
}
