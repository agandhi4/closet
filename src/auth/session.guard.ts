import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { IS_PUBLIC_KEY } from './public.decorator';
import {
  LoginRequiredException,
  RedirectToLoginException,
} from './redirect-to-login.exception';
import { decideSessionAccess } from './session-access';

/**
 * The authentication gate for Nest routes, registered as APP_GUARD in
 * AppModule: every Nest route needs a signed-in user unless it is marked
 * @Public(). Plain-Fastify routes (src/web/) have their own hook; both take
 * the decision from decideSessionAccess. It only reads `req.auth`, which
 * AuthContextService resolved once in the preHandler hook in app.ts; it never
 * touches the cookie or the JWT. Static paths skip that hook, so a route under
 * one (FileController) never has a session and must be @Public().
 *
 * A guard cannot answer the request itself, so it throws and ErrorViewFilter
 * sends the 302 or the 401 with `HX-Redirect`.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC_KEY,
      [context.getHandler(), context.getClass()],
    );
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    switch (decideSessionAccess(request, isPublic === true)) {
      case 'allow':
        return true;
      case 'redirect-to-login':
        throw new RedirectToLoginException();
      case 'login-required':
        throw new LoginRequiredException();
    }
  }
}
