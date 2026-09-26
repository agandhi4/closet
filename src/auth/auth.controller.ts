import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  Query,
  Redirect,
  Render,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import type { FastifyReply } from 'fastify';
import { I18n, I18nContext } from 'nestjs-i18n';
import { Public } from './public.decorator';
import { RegistrationGuard } from './registration.guard';
import { AuthService } from './auth.service';
import { ConfigService } from '@nestjs/config';
import { ChangePasswordDto } from './dto/changePassword.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { UserId } from './user.decorator';
import { UpdateEmailDto } from './dto/updateEmail.dto';
import { seconds, Throttle } from '@nestjs/throttler';

// Sign-in, registration and logout are @Public(); the account pages need a
// session like every other route (SessionGuard).
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private authService: AuthService,
    private configService: ConfigService,
  ) {}

  @Public()
  @UseGuards(RegistrationGuard)
  @Post('register')
  async postRegister(
    @I18n() i18n: I18nContext,
    @Body() body: RegisterDto,
    @Res() reply: FastifyReply,
  ): Promise<any> {
    const instance = plainToInstance(RegisterDto, body);
    const validationErrors = await i18n.validate(instance);
    if (validationErrors.length) {
      return reply.view('auth/register', {
        layout: 'layout',
        input: body,
        validationErrors,
        ...(reply.locals ?? {}),
      });
    }

    const jwt = await this.authService.register(body.email, body.password);
    setSessionCookie(reply, jwt);
    return reply.redirect('/auth/profile', 302);
  }

  @Public()
  @UseGuards(RegistrationGuard)
  @Render('auth/register')
  @Post('validate/register')
  async postRegisterValidate(
    @I18n() i18n: I18nContext,
    @Body() body: RegisterDto,
  ) {
    const instance = plainToInstance(RegisterDto, body);
    const validationErrors = await i18n.validate(instance);
    if (validationErrors.length) {
      return {
        input: body,
        validationErrors,
      };
    }

    return { input: body };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @Post('login')
  async postLogin(@Body() loginDto: LoginDto, @Res() reply: FastifyReply) {
    try {
      const jwt = await this.authService.signIn(
        loginDto.email,
        loginDto.password,
      );
      setSessionCookie(reply, jwt);
      reply.redirect('/auth/profile', 302);
    } catch (error) {
      this.logger.warn(error);
      return reply.view('auth/login', {
        layout: 'layout',
        error,
        ...(reply.locals ?? {}),
      });
    }
  }

  @Public()
  @Redirect('/')
  @Get('logout')
  getLogout(
    // https://docs.nestjs.com/techniques/cookies#use-with-express-default
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.clearCookie('access_token', { path: '/' });
  }

  @Public()
  @Get('login')
  @Render('auth/login')
  getLogin(@I18n() i18n: I18nContext): any {
    const appName = this.configService.get<string>('APP_NAME');
    return {
      ogTitle: i18n.t('lang.LOGIN_OG_TITLE', { args: { appName } }),
      ogDescription: i18n.t('lang.LOGIN_OG_DESC', { args: { appName } }),
    };
  }

  @Public()
  @UseGuards(RegistrationGuard)
  @Get('register')
  @Render('auth/register')
  getRegister(@I18n() i18n: I18nContext): any {
    const appName = this.configService.get<string>('APP_NAME');
    return {
      ogTitle: i18n.t('lang.REGISTER_OG_TITLE', { args: { appName } }),
      ogDescription: i18n.t('lang.REGISTER_OG_DESC', { args: { appName } }),
    };
  }

  @Get('profile')
  @Render('auth/profile')
  getProfile(@Query('passwordChanged') passwordChanged?: string) {
    return { passwordChanged: passwordChanged === '1' };
  }

  @Get('delete-account')
  @Render('auth/delete-account')
  getDeleteAccount(): any {}

  @Post('delete-account')
  async postDeleteAccount(
    @UserId() userId: number,
    @Body() loginDto: LoginDto,
    @Res() reply: FastifyReply,
  ) {
    try {
      await this.authService.deleteUser(userId, loginDto);
      reply.clearCookie('access_token', { path: '/' });
      return reply.redirect('/', 302);
    } catch (error) {
      this.logger.warn(error);
      // 401 for wrong credentials or another account's (UnauthorizedException
      // from deleteUser), 400 for anything a malformed body caused.
      const status =
        error instanceof HttpException
          ? error.getStatus()
          : HttpStatus.BAD_REQUEST;
      return reply.status(status).view('auth/delete-account', {
        layout: 'layout',
        error,
        ...(reply.locals ?? {}),
      });
    }
  }

  @Get('update-email')
  @Render('auth/update-email')
  getUpdateEmail() {}

  @Render('auth/update-email')
  @Post('validate/update-email')
  async postValidateUpdateEmail(
    @I18n() i18n: I18nContext,
    @Body() body: UpdateEmailDto,
  ) {
    const instance = plainToInstance(UpdateEmailDto, body);
    const validationErrors = await i18n.validate(instance);
    if (validationErrors.length) {
      return {
        input: body,
        validationErrors,
      };
    }

    return { input: body };
  }

  @Post('update-email')
  async postUpdateEmail(
    @UserId() userId: number,
    @I18n() i18n: I18nContext,
    @Body() body: UpdateEmailDto,
    @Res() reply: FastifyReply,
  ) {
    const instance = plainToInstance(UpdateEmailDto, body);
    const validationErrors = await i18n.validate(instance);
    if (validationErrors.length) {
      return reply.view('auth/update-email', {
        layout: 'layout',
        input: body,
        validationErrors,
        ...(reply.locals ?? {}),
      });
    }

    await this.authService.changeEmail(userId, body.confirmEmail);
    return reply.redirect('/auth/profile', 302);
  }

  @Get('change-password')
  @Render('auth/change-password')
  getChangePassword() {}

  // A refused change answers 400 with the form re-rendered; the form is a
  // native (unboosted) post so the browser shows it, see
  // views/auth/change-password.hbs. Passwords are never echoed back.
  @Post('change-password')
  async postChangePassword(
    @UserId() userId: number,
    @I18n() i18n: I18nContext,
    @Body() body: ChangePasswordDto,
    @Res() reply: FastifyReply,
  ) {
    const rerender = (validationErrors: unknown[]) =>
      reply.status(HttpStatus.BAD_REQUEST).view('auth/change-password', {
        layout: 'layout',
        validationErrors,
        ...(reply.locals ?? {}),
      });

    const validationErrors = await i18n.validate(
      plainToInstance(ChangePasswordDto, body),
    );
    if (validationErrors.length) return rerender(validationErrors);

    let jwt: string;
    try {
      jwt = await this.authService.changePassword(
        userId,
        body.currentPassword,
        body.newPassword,
      );
    } catch (error) {
      if (!(error instanceof UnauthorizedException)) throw error;
      // Shaped like a class-validator error so the template's filterErrors
      // shows it under the field like every other message.
      return rerender([
        {
          property: 'currentPassword',
          constraints: {
            currentPassword: i18n.t('lang.WRONG_CURRENT_PASSWORD'),
          },
        },
      ]);
    }
    // The new hash revoked every older token, this session's included:
    // replace it so the user stays signed in here.
    setSessionCookie(reply, jwt);
    return reply.redirect('/auth/profile?passwordChanged=1', 302);
  }
}

function setSessionCookie(reply: FastifyReply, jwt: string): void {
  reply.setCookie('access_token', jwt, {
    path: '/',
    maxAge: 365 * 24 * 60 * 60 * 1000, // 365 days
    httpOnly: true, // Prevents client-side JS from reading it
  });
}
