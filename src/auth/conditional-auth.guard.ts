import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FastifyRequest } from 'fastify';
import { RedirectToLoginException } from './redirect-to-login.exception';

/**
 * When AUTH_ENABLED=false: passes all requests through (no auth needed).
 * When AUTH_ENABLED=true: requires the session resolved by AuthContextService
 * (`req.auth`, see app.ts) and exposes its payload as request.user.
 *   - Authenticated: passes through.
 *   - Unauthenticated: 302 to /auth/login (RedirectToLoginException, sent by
 *     ErrorViewFilter) instead of a 401/403 dead end.
 */
@Injectable()
export class ConditionalAuthGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.configService.get<boolean>('AUTH_ENABLED')) {
      return true;
    }

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (request.auth) {
      request.user = request.auth.payload;
      return true;
    }

    throw new RedirectToLoginException();
  }
}
