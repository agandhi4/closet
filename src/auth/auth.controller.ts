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
  UseGuards,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import type { FastifyReply } from 'fastify';
import { I18n, I18nContext } from 'nestjs-i18n';
import { AuthGuard } from './auth.guard';
import { RegistrationGuard } from './registration.guard';
import { AuthService } from './auth.service';
import { ConfigService } from '@nestjs/config';
import { EmailDto } from './dto/email.dto';
import { LoginDto } from './dto/login.dto';
import { Payload } from './dto/payload.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/resetPassword.dto';
import { User } from './user.decorator';
import { UpdateEmailDto } from './dto/updateEmail.dto';
import { minutes, seconds, Throttle } from '@nestjs/throttler';

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private authService: AuthService,
    private configService: ConfigService,
  ) {}

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
    reply.setCookie('access_token', jwt, {
      path: '/',
      maxAge: 365 * 24 * 60 * 60 * 1000, // 365 days
      httpOnly: true, // Prevents client-side JS from reading it
    });
    return reply.redirect('/auth/profile', 302);
  }

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

  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @Post('login')
  async postLogin(@Body() loginDto: LoginDto, @Res() reply: FastifyReply) {
    try {
      const jwt = await this.authService.signIn(
        loginDto.email,
        loginDto.password,
      );
      reply.setCookie('access_token', jwt, {
        path: '/',
        maxAge: 365 * 24 * 60 * 60 * 1000, // 365 days
        httpOnly: true, // Prevents client-side JS from reading it
      });
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

  @Redirect('/')
  @Get('logout')
  getLogout(
    // https://docs.nestjs.com/techniques/cookies#use-with-express-default
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.clearCookie('access_token', { path: '/' });
  }

  @Get('login')
  @Render('auth/login')
  getLogin(@I18n() i18n: I18nContext): any {
    const appName = this.configService.get<string>('APP_NAME');
    return {
      ogTitle: i18n.t('lang.LOGIN_OG_TITLE', { args: { appName } }),
      ogDescription: i18n.t('lang.LOGIN_OG_DESC', { args: { appName } }),
    };
  }

  @Get('reset')
  @Render('auth/reset')
  getReset(@Query('email') emailQueryParam: string): any {
    return {
      input: {
        email: emailQueryParam,
      },
    };
  }

  @Post('reset')
  async postReset(@Body() emailDto: EmailDto, @Res() reply: FastifyReply) {
    try {
      await this.authService.sendPasswordResetEmail(emailDto.email);
      return reply.redirect(`/auth/reset-code?email=${emailDto.email}`, 302);
    } catch (error) {
      this.logger.warn(error);
      return reply.view('auth/reset', {
        layout: 'layout',
        error,
        ...(reply.locals ?? {}),
      });
    }
  }

  @Get('reset-code')
  @Render('auth/reset-code')
  getResetCode(@Query('email') emailQueryParam: string): any {
    return {
      input: {
        email: emailQueryParam,
      },
    };
  }

  @Throttle({ default: { limit: 5, ttl: minutes(10) } })
  @Render('auth/reset-code')
  @Post('validate/reset-code')
  async postResetCodeValidate(
    @I18n() i18n: I18nContext,
    @Body() body: ResetPasswordDto,
  ) {
    const instance = plainToInstance(ResetPasswordDto, body);
    const validationErrors = await i18n.validate(instance);
    if (validationErrors.length) {
      return {
        input: body,
        validationErrors,
      };
    }

    return { input: body };
  }

  @Post('reset-code')
  async postResetCode(
    @I18n() i18n: I18nContext,
    @Body() body: ResetPasswordDto,
    @Res() reply: FastifyReply,
  ) {
    const instance = plainToInstance(ResetPasswordDto, body);
    const validationErrors = await i18n.validate(instance);
    if (validationErrors.length) {
      return reply.view('auth/reset-code', {
        layout: 'layout',
        input: body,
        validationErrors,
        ...(reply.locals ?? {}),
      });
    }

    await this.authService.resetPassword(body);
    return reply.redirect('/auth/login', 302);
  }

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

  @UseGuards(AuthGuard)
  @Get('profile')
  @Render('auth/profile')
  getProfile(): any {}

  @UseGuards(AuthGuard)
  @Get('delete-account')
  @Render('auth/delete-account')
  getDeleteAccount(): any {}

  @UseGuards(AuthGuard)
  @Post('delete-account')
  async postDeleteAccount(
    @User() payload: Payload,
    @Body() loginDto: LoginDto,
    @Res() reply: FastifyReply,
  ) {
    try {
      await this.authService.deleteUser(payload.userId, loginDto);
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

  @UseGuards(AuthGuard)
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

  @UseGuards(AuthGuard)
  @Post('update-email')
  async postUpdateEmail(
    @User() payload: Payload,
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

    await this.authService.changeEmail(payload.userId, body.confirmEmail);
    return reply.redirect('/auth/profile', 302);
  }
}
