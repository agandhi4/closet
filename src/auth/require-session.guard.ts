import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Pages and form submissions that only exist with user accounts (wardrobe
 * sharing): 404 when AUTH_ENABLED=false, 302 to /auth/login without a
 * session (it is a browser navigation, so a 401 page would be a dead end),
 * pass with request.user set otherwise. Fetch-driven endpoints use AuthGuard
 * (401) instead; open-or-authenticated routes use ConditionalAuthGuard.
 */
@Injectable()
export class RequireSessionGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.configService.get<boolean>('AUTH_ENABLED')) {
      throw new NotFoundException();
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
