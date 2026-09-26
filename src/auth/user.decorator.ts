import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

/**
 * The signed-in user's id, from the session AuthContextService resolved for
 * this request. Only valid on routes SessionGuard protects (not @Public()),
 * where a session is guaranteed; on a public route it is a programming error.
 */
export const UserId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): number => {
    const request = ctx.switchToHttp().getRequest<FastifyRequest>();
    if (!request.auth) {
      throw new Error(
        `@UserId() on ${request.method} ${request.url}, which has no session: is the route @Public()?`,
      );
    }
    return request.auth.user.id;
  },
);
