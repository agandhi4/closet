import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FastifyReply, FastifyRequest } from 'fastify';

/**
 * When AUTH_ENABLED=false: passes all requests through (no auth needed).
 * When AUTH_ENABLED=true: requires the session resolved by AuthContextService
 * (`req.auth`, see app.ts) and exposes its payload as request.user.
 *   - Authenticated: passes through.
 *   - Unauthenticated: redirects to /auth/login instead of returning 401/403.
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

    const response = context.switchToHttp().getResponse<FastifyReply>();
    void response.redirect('/auth/login', 302);
    return false;
  }
}
