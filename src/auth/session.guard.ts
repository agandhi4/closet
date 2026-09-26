import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { isFragmentRequest } from '../htmx/fragment-request';
import { IS_PUBLIC_KEY } from './public.decorator';
import {
  LoginRequiredException,
  RedirectToLoginException,
} from './redirect-to-login.exception';

/**
 * The one authentication gate, registered as APP_GUARD in AppModule: every
 * Nest route needs a signed-in user unless it is marked @Public(). It only
 * reads `req.auth`, which AuthContextService resolved once in the preHandler
 * hook in app.ts; it never touches the cookie or the JWT. Static paths skip
 * that hook, so a route under one (FileController, /healthz, /manifest.json)
 * never has a session and must be @Public().
 *
 * Without a session a page navigation is redirected to the login page; an
 * htmx fragment request or a fetch gets a 401 with `HX-Redirect` instead
 * (see LoginRequiredException).
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (request.auth) return true;

    if (isPageNavigation(request)) throw new RedirectToLoginException();
    throw new LoginRequiredException();
  }
}

/**
 * htmx marks its own requests: boosted links and history restores want a
 * page, everything else is a fragment (isFragmentRequest, shared with the
 * service worker). Other script requests are told apart by Sec-Fetch-Mode,
 * which browsers set to `navigate` only for navigations and plain form posts.
 * A client that sends no fetch metadata (curl, an old browser) is treated as
 * a navigation: a redirect is what a person at a browser needs.
 */
function isPageNavigation(request: FastifyRequest): boolean {
  if (request.headers['hx-request'] === 'true') {
    return !isFragmentRequest(request.headers);
  }
  const mode = request.headers['sec-fetch-mode'];
  return mode === undefined || mode === 'navigate';
}
