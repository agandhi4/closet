import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FastifyRequest } from 'fastify';

/**
 * Routes that only make sense with user accounts: 404 when AUTH_ENABLED=false,
 * 401 without a session. The session itself is resolved once per request by
 * AuthContextService (`req.auth`, see main.ts); this guard only publishes its
 * payload as request.user for the @User() decorator.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.configService.get<boolean>('AUTH_ENABLED')) {
      throw new NotFoundException();
    }

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (!request.auth) {
      throw new UnauthorizedException();
    }
    request.user = request.auth.payload;
    return true;
  }
}
