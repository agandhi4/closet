import type { FastifyReply } from 'fastify';
import type { SessionUser } from './auth/session';

/**
 * The per-request page context: built by ViewContextService in the
 * preValidation hook in app.ts for every non-static request (Nest and
 * plain-Fastify routes alike) and stored as `reply.locals`; JSX pages take
 * it as a prop. Text is not in it: pages are English, from t()
 * (src/web/i18n.ts).
 */
export interface ViewContext {
  appName: string;
  /** File under public/assets/ (ICON_NAME). */
  iconName: string;
  /** SITE_URL, else the request host. */
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
