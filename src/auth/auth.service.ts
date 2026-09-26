import { EntityManager, EntityRepository } from '@mikro-orm/core';
import { InjectRepository } from '@mikro-orm/nestjs';
import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { File } from '../dal/entity/file.entity';
import { User } from '../dal/entity/user.entity';
import * as bcrypt from 'bcryptjs';
import { LoginDto } from './dto/login.dto';
import { Payload } from './dto/payload.dto';
import { FileService } from '../file/file-service.abstract';

const BCRYPT_ROUNDS = 12;

@Injectable()
export class AuthService {
  private logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: EntityRepository<User>,
    private jwtService: JwtService,
    private readonly em: EntityManager,
    private readonly fileService: FileService,
  ) {}

  async register(email: string, password: string): Promise<string> {
    this.logger.debug(this.register.name);
    const existingUser = await this.userRepository.findOne({ email });
    if (existingUser) {
      this.logger.debug(`User already exists with email address: ${email}`);
      throw new HttpException('Forbidden', HttpStatus.FORBIDDEN);
    }

    const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = this.userRepository.create({
      email,
      password: hashedPassword,
    } as User);
    await this.em.persistAndFlush(user);

    return this.signToken(user);
  }

  async signIn(email: string, password: string): Promise<string> {
    const user = await this.userRepository.findOneOrFail({ email });
    const valid = await bcrypt.compare(password, user?.password);
    if (!valid) {
      throw new UnauthorizedException();
    }
    return this.signToken(user);
  }

  /**
   * Replaces the password after re-checking the current one
   * (UnauthorizedException when it is wrong; nothing changes). The new hash
   * changes the password fingerprint, so AuthContextService rejects every
   * token issued before; the returned token is the caller's replacement
   * session.
   */
  async changePassword(
    userId: number,
    currentPassword: string,
    newPassword: string,
  ): Promise<string> {
    const user = await this.userRepository.findOneOrFail({ id: userId });
    if (!(await bcrypt.compare(currentPassword, user.password))) {
      this.logger.log(
        `Password change refused for user ${userId}: wrong current password`,
      );
      throw new UnauthorizedException();
    }
    user.password = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await this.em.flush();
    this.logger.log(
      `Password changed for user ${userId}; other sessions revoked`,
    );
    return this.signToken(user);
  }

  public async changeEmail(userId: number, newEmail: string) {
    const user = await this.userRepository.findOneOrFail({ id: userId });
    user.email = newEmail;
    await this.em.persistAndFlush(user);
  }

  /**
   * Deletes the account after re-checking its own credentials (the form asks
   * for them again; they must belong to the user being deleted, not to any
   * account). The user's File rows go in the same transaction as the user:
   * the DB cascade on garment.owner and file.created_by would drop the rows
   * on its own, but only this path removes the bytes behind them. Variants
   * are unlinked after commit, like GarmentService.remove.
   */
  async deleteUser(userId: number, credentials: LoginDto): Promise<void> {
    const fileNames = await this.em.transactional(async (em) => {
      const user = await em.findOneOrFail(User, { id: userId });
      const valid =
        user.email === credentials.email &&
        (await bcrypt.compare(credentials.password, user.password));
      if (!valid) throw new UnauthorizedException();

      const files = await em.find(File, { createdBy: user });
      em.remove(files);
      em.remove(user);
      return files.map((file) => file.fileName);
    });
    for (const fileName of fileNames) {
      await this.fileService.deleteVariants(fileName);
    }
    this.logger.log(
      `Deleted user ${userId} and ${fileNames.length} of their photos`,
    );
  }

  // `pwf` is the tail of the bcrypt hash: AuthContextService compares it on
  // every request, which is what ends older sessions after a password change.
  private signToken(user: User): Promise<string> {
    return this.jwtService.signAsync({
      userId: user.id,
      email: user.email,
      pwf: user.password.slice(-8),
    } as Payload);
  }
}
