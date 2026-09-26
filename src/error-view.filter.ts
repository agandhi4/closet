import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import {
  LoginRequiredException,
  RedirectToLoginException,
} from './auth/redirect-to-login.exception';
import { createErrorHandler } from './web/errors';

@Catch()
export class ErrorViewFilter implements ExceptionFilter {
  private logger = new Logger(ErrorViewFilter.name);
  // Nest's own failures (a path no route matches) get the web layer's
  // answer: the JSX error page, or data where there is no page context.
  private readonly handleError = createErrorHandler(this.logger);

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
    await this.handleError(exception, request, response);
  }
}
