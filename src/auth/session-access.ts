import type { FastifyRequest } from 'fastify';
import { isFragmentRequest } from '../htmx/fragment-request';

export const LOGIN_PATH = '/auth/login';

/**
 * What a request gets from the session gate:
 *  - `allow`: the route is public or the request has a session;
 *  - `redirect-to-login`: a page navigation without a session, answered with
 *    a 302 to LOGIN_PATH;
 *  - `login-required`: an htmx fragment or fetch without a session, answered
 *    with a bodiless 401 and `HX-Redirect: LOGIN_PATH` (a 302 would be
 *    followed by the XHR and the login page swapped into a fragment target).
 */
export type SessionAccess = 'allow' | 'redirect-to-login' | 'login-required';

/**
 * The one session decision, shared by both gates so they cannot drift:
 * SessionGuard (Nest routes, @Public()) and requireSession in src/web/auth/require-session.ts
 * (plain-Fastify routes, `config: { public: true }`). It only reads
 * `req.auth`, which the preHandler in app.ts resolved.
 */
export function decideSessionAccess(
  request: Pick<FastifyRequest, 'auth' | 'headers'>,
  isPublic: boolean,
): SessionAccess {
  if (isPublic || request.auth) return 'allow';
  return isPageNavigation(request) ? 'redirect-to-login' : 'login-required';
}

/**
 * htmx marks its own requests: boosted links and history restores want a
 * page, everything else is a fragment (isFragmentRequest, shared with the
 * service worker). Other script requests are told apart by Sec-Fetch-Mode,
 * which browsers set to `navigate` only for navigations and plain form posts.
 * A client that sends no fetch metadata (curl, an old browser) is treated as
 * a navigation: a redirect is what a person at a browser needs.
 */
function isPageNavigation(request: Pick<FastifyRequest, 'headers'>): boolean {
  if (request.headers['hx-request'] === 'true') {
    return !isFragmentRequest(request.headers);
  }
  const mode = request.headers['sec-fetch-mode'];
  return mode === undefined || mode === 'navigate';
}
