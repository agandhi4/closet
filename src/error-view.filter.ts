import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import {
  LoginRequiredException,
  RedirectToLoginException,
} from './auth/redirect-to-login.exception';
import { describeError } from './web/errors';

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
    if (exception instanceof LoginRequiredException) {
      this.logger.debug(
        `${request.url} -> 401, HX-Redirect ${exception.location}`,
      );
      return response
        .status(exception.getStatus())
        .header('HX-Redirect', exception.location)
        .send();
    }

    this.logger.warn(exception);

    if (response.sent) {
      this.logger.warn('Response already sent, skipping error filter');
      return;
    }

    // One mapping for both stacks: Nest's HttpExceptions and the web
    // layer's HttpError, which plain modules called from Nest services throw
    // (an unreadable photo from src/web/files is a 400 here too).
    const { status, message } = describeError(exception);

    try {
      // locals is only missing on static paths (see isStaticPath in app.ts),
      // whose errors are asset 404s; the page still renders, just without
      // the app name and session.
      await response.status(status).view('error', {
        layout: 'layout',
        statusCode: status,
        message,
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
