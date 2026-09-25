import { HttpException, HttpStatus } from '@nestjs/common';

export const LOGIN_PATH = '/auth/login';

/**
 * Thrown by the page guards (ConditionalAuthGuard, RequireSessionGuard) when
 * a browser navigation arrives without a session. A guard cannot answer a
 * request itself: returning false after reply.redirect() makes Nest raise a
 * ForbiddenException on an already-sent reply, which ErrorViewFilter would
 * log twice at warn. Instead the guard throws this and the filter turns it
 * into the 302 (see ErrorViewFilter.catch). AuthGuard keeps 401 for
 * fetch-driven routes, where a redirect would be swallowed by the caller.
 */
export class RedirectToLoginException extends HttpException {
  constructor(readonly location: string = LOGIN_PATH) {
    super(`Redirecting to ${location}`, HttpStatus.FOUND);
  }
}
