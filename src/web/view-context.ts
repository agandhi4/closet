import type { FastifyReply, FastifyRequest } from 'fastify';
import { BUILD_INFO } from '../build-info';
import type { AuthContext, SessionUser } from './auth/session';
import { requestOrigin } from './security/origin';

/**
 * The per-request page context: built by the preValidation hook in app.ts
 * for every non-static request (createViewContextBuilder) and stored as
 * `reply.locals`; JSX pages take it as a prop. Text is not in it: pages are
 * English, from t() (src/web/i18n.ts).
 */
export interface ViewContext {
  appName: string;
  /** File under public/assets/ (ICON_NAME). */
  iconName: string;
  /** SITE_URL. */
  siteUrl: string;
  /** The request URL (path and query; '' for '/'): the dock marks its tab active on an exact match. */
  baseUrl: string;
  signupsDisabled: boolean;
  pwaEnabled: boolean;
  /** `?v=` on every first-party static URL; see src/build-info.ts. */
  appVersion: string;
  /** package.json version, shown on /about. */
  appRelease: string;
  canonicalUrl: string;
  /** The page's link preview URL and image unless the page names its own (Layout). */
  ogUrl: string;
  ogImage: string;
  user: SessionUser | undefined;
}

/**
 * The context of a page request. Absent only on the static paths the session
 * hook skips (static-prefixes.ts), where no route renders a page, so a
 * missing context is a routing mistake, not a runtime condition.
 */
export function viewContext(reply: FastifyReply): ViewContext {
  if (!reply.locals) {
    throw new Error(
      `No view context for ${reply.request.url}: is a page route under a static prefix?`,
    );
  }
  return reply.locals;
}

/** What the page context takes from config, resolved once by createApp(). */
export interface ViewContextConfig {
  appName: string;
  iconName: string;
  siteUrl: string;
  registrationDisabled: boolean;
  pwaEnabled: boolean;
}

/**
 * Builds a request's page context. The session comes in as an argument: the
 * builder never reads the cookie or loads the user itself (the session
 * resolver already did).
 */
export function createViewContextBuilder(config: ViewContextConfig) {
  return function buildViewContext(
    request: FastifyRequest,
    auth: AuthContext | undefined,
  ): ViewContext {
    // Forwarded headers only count from TRUSTED_PROXIES (requestOrigin); a
    // client's own X-Forwarded-Host must not rewrite canonical and og URLs.
    const origin = requestOrigin(request);
    const canonicalUrl = `${origin}${request.url.split('?')[0]}`;
    return {
      appName: config.appName,
      iconName: config.iconName,
      siteUrl: config.siteUrl,
      baseUrl: request.url === '/' ? '' : request.url,
      signupsDisabled: config.registrationDisabled,
      pwaEnabled: config.pwaEnabled,
      appVersion: BUILD_INFO.assetVersion,
      appRelease: BUILD_INFO.version,
      canonicalUrl,
      ogUrl: canonicalUrl,
      ogImage: `${origin}/assets/${config.iconName}`,
      user: auth?.user,
    };
  };
}
