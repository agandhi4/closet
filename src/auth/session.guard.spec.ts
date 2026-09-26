import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Public } from './public.decorator';
import {
  LoginRequiredException,
  RedirectToLoginException,
} from './redirect-to-login.exception';
import { SessionGuard } from './session.guard';

class Routes {
  @Public()
  open(this: void) {}

  closed(this: void) {}
}

@Public()
class PublicController {
  anything(this: void) {}
}

describe('SessionGuard', () => {
  const guard = new SessionGuard(new Reflector());

  const context = (
    handler: () => void,
    controller: new () => unknown,
    request: Record<string, unknown>,
  ) =>
    ({
      getHandler: () => handler,
      getClass: () => controller,
      switchToHttp: () => ({ getRequest: () => request }),
    }) as unknown as ExecutionContext;

  const anonymous = (headers: Record<string, string> = {}) => ({ headers });
  const signedIn = { headers: {}, auth: { user: { id: 3 }, payload: {} } };

  it('lets an anonymous request through a @Public() route', () => {
    expect(
      guard.canActivate(context(Routes.prototype.open, Routes, anonymous())),
    ).toBe(true);
  });

  it('lets an anonymous request through a @Public() controller', () => {
    expect(
      guard.canActivate(
        context(
          PublicController.prototype.anything,
          PublicController,
          anonymous(),
        ),
      ),
    ).toBe(true);
  });

  it('lets a request with a session through a protected route', () => {
    expect(
      guard.canActivate(context(Routes.prototype.closed, Routes, signedIn)),
    ).toBe(true);
  });

  it.each([
    ['no fetch metadata (curl, inject)', {}],
    ['a browser navigation', { 'sec-fetch-mode': 'navigate' }],
    [
      'an htmx boosted navigation',
      { 'hx-request': 'true', 'hx-boosted': 'true', 'sec-fetch-mode': 'cors' },
    ],
    [
      'an htmx history restore',
      {
        'hx-request': 'true',
        'hx-history-restore-request': 'true',
        'sec-fetch-mode': 'cors',
      },
    ],
  ])('redirects %s to the login page', (_label, headers) => {
    expect(() =>
      guard.canActivate(
        context(Routes.prototype.closed, Routes, anonymous(headers)),
      ),
    ).toThrow(RedirectToLoginException);
  });

  it.each([
    [
      'an htmx fragment request',
      { 'hx-request': 'true', 'sec-fetch-mode': 'cors' },
    ],
    ['a fetch()', { 'sec-fetch-mode': 'cors' }],
    ['a same-origin fetch()', { 'sec-fetch-mode': 'same-origin' }],
  ])('answers %s with LoginRequiredException (401)', (_label, headers) => {
    expect(() =>
      guard.canActivate(
        context(Routes.prototype.closed, Routes, anonymous(headers)),
      ),
    ).toThrow(LoginRequiredException);
  });
});
