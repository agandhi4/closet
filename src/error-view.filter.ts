import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { RedirectToLoginException } from './auth/redirect-to-login.exception';

@Catch()
export class ErrorViewFilter implements ExceptionFilter {
  private logger = new Logger(ErrorViewFilter.name);

  async catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    // A logged-out page hit is routine, not an error: send the redirect the
    // guard asked for and keep it out of the warn log.
    if (exception instanceof RedirectToLoginException) {
      this.logger.debug(`${request.url} -> ${exception.location}`);
      return response.redirect(exception.location, exception.getStatus());
    }

    this.logger.warn(exception);

    if (response.sent) {
      this.logger.warn('Response already sent, skipping error filter');
      return;
    }

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const message =
      exception instanceof HttpException
        ? exception.getResponse()
        : 'Internal server error';

    try {
      // locals is only missing on static paths (see isStaticPath in app.ts),
      // whose errors are asset 404s; the page still renders, just without
      // the app name and session.
      await response.status(status).view('error', {
        layout: 'layout',
        statusCode: status,
        message:
          typeof message === 'string' ? message : (message as any).message,
        timestamp: new Date().toISOString(),
        path: request.url,
        ...(response.locals ?? {}),
      });
    } catch (renderError) {
      this.logger.error(renderError);
      response.status(status).send({ statusCode: status, message });
    }
  }
}
