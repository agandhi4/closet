import { HttpException, HttpStatus } from '@nestjs/common';
import { LOGIN_PATH } from './session-access';

/**
 * Thrown by SessionGuard when a page navigation arrives without a session. A
 * guard cannot answer a request itself: returning false after
 * reply.redirect() makes Nest raise a ForbiddenException on an already-sent
 * reply, which ErrorViewFilter would log twice at warn. Instead the guard
 * throws this and the filter turns it into the 302 (see ErrorViewFilter.catch).
 */
export class RedirectToLoginException extends HttpException {
  constructor(readonly location: string = LOGIN_PATH) {
    super(`Redirecting to ${location}`, HttpStatus.FOUND);
  }
}

/**
 * SessionGuard's answer to an htmx fragment or fetch request without a
 * session: a 302 would be followed by the XHR, and the login page swapped
 * into a fragment target (or read by a fetch caller as success).
 * ErrorViewFilter sends it as a bodiless 401 with `HX-Redirect`, which htmx
 * follows with a full navigation whatever the status.
 */
export class LoginRequiredException extends HttpException {
  constructor(readonly location: string = LOGIN_PATH) {
    super('Login required', HttpStatus.UNAUTHORIZED);
  }
}
