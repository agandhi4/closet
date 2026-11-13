import type { FastifyRequest, RouteOptions } from 'fastify';

/**
 * Which client a route serves (#190; docs/plans/2026-11-12-json-api.md
 * section 3), and so which credential counts and how errors answer:
 *  - `page`: the PWA's HTML, the session cookie, error pages;
 *  - `mcp`: /mcp, an `mcp` personal access token, never the cookie;
 *  - `api`: /api/v1, a `device` token, never the cookie, problem+json.
 * Read through surfaceOf(); a route without one is a page.
 */
export type Surface = 'page' | 'mcp' | 'api';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * Set only on /mcp's routes (`'mcp'`); `'api'` is stamped by
     * assignSurface on every /api/v1 route and may be spelled nowhere else.
     */
    surface?: Surface;
  }
}

export const API_PREFIX = '/api/v1';

/** Any spelling of /api, in any case, and what is under it. */
const API_PATH = /^\/api(?:[/?#]|$)/i;

/**
 * The surface a request is on: its route's, else `api` for any spelling of
 * /api (`/api`, `/API/v1/me`) and `page` for the rest. The fallback serves
 * the requests no /api/v1 route matched: the not-found handler's, and a
 * GET that the static files' `GET /*` wildcard matched before it falls to
 * not-found. So an unknown API path is a problem 404 and never resolves
 * the cookie. Every hook that treats surfaces apart (the session
 * resolution in app.ts, requireSession, the same-origin check, the error
 * handler) asks this, never the config or the URL itself.
 */
export function surfaceOf(
  request: Pick<FastifyRequest, 'routeOptions' | 'url'>,
): Surface {
  return (
    request.routeOptions.config.surface ??
    (API_PATH.test(request.url) ? 'api' : 'page')
  );
}

function underApiPrefix(url: string): boolean {
  return url === API_PREFIX || url.startsWith(`${API_PREFIX}/`);
}

/**
 * The root onRoute hook (createApp adds it before any route): every route
 * under /api/v1, the HEAD twins Fastify adds included, is the `api`
 * surface, and no other route is. A route that says otherwise, or a path
 * under /api that is not /api/v1, stops the boot: the API's guarantees
 * (no cookie, no CSRF exemption for a cookie, problem+json) hang on it.
 */
export function assignSurface(route: RouteOptions): void {
  const declared = route.config?.surface;
  if (underApiPrefix(route.url)) {
    if (declared !== undefined && declared !== 'api') {
      throw new Error(
        `${String(route.method)} ${route.url} is under ${API_PREFIX} but says surface '${declared}'`,
      );
    }
    route.config = { ...route.config, surface: 'api' };
    return;
  }
  if (API_PATH.test(route.url)) {
    throw new Error(
      `${String(route.method)} ${route.url}: the API lives under ${API_PREFIX} only`,
    );
  }
  if (declared === 'api') {
    throw new Error(
      `${String(route.method)} ${route.url} says surface 'api' outside ${API_PREFIX}`,
    );
  }
}
