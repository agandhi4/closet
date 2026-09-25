import { EntityRepository } from '@mikro-orm/core';
import { InjectRepository } from '@mikro-orm/nestjs';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { FastifyRequest } from 'fastify';
import { User } from '../dal/entity/user.entity';
import { Payload } from './dto/payload.dto';

export interface AuthContext {
  user: User;
  payload: Payload;
}

/**
 * The one place a request's session is established: cookie -> JWT -> User row
 * -> password fingerprint. Runs once per non-static request from the
 * preHandler hook in main.ts, which stores the result as `req.auth`. Guards
 * and ViewContextService read `req.auth`; none of them touch the cookie, the
 * JwtService or the user repository themselves.
 */
@Injectable()
export class AuthContextService {
  private readonly logger = new Logger(AuthContextService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: EntityRepository<User>,
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
  ) {}

  async resolve(req: FastifyRequest): Promise<AuthContext | undefined> {
    if (!this.configService.get<boolean>('AUTH_ENABLED')) {
      return undefined;
    }
    const token = req.cookies?.['access_token'];
    if (!token) {
      return undefined;
    }

    let payload: Payload;
    try {
      payload = await this.jwtService.verifyAsync<Payload>(token);
    } catch (error) {
      this.logger.log(
        `Rejected access token: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }

    const user = await this.userRepository.findOne({ id: payload.userId });
    if (!user) {
      this.logger.log(`Access token for unknown user ${payload.userId}`);
      return undefined;
    }
    // The fingerprint is the tail of the bcrypt hash (see AuthService.signIn),
    // so every token issued before a password change stops working.
    if (user.password.slice(-8) !== payload.pwf) {
      this.logger.log(`Password fingerprint mismatch for user ${user.id}`);
      return undefined;
    }
    return { user, payload };
  }
}
