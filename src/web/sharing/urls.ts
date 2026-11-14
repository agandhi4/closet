import { profileSection, PROFILE_PATH } from '../auth/urls';
import type { AcceptRefusal } from './queries';

/**
 * Where sharing is managed: Profile › Sharing (docs/plans/
 * 2026-09-26-redesign.md, "Where every route goes"). The writes under
 * /wardrobe-share land there, and the old manage page redirects there.
 */
export const SHARING_SECTION_ID = 'sharing';
export const SHARING_PATH = profileSection(SHARING_SECTION_ID);

/**
 * The manage page before Sharing moved into Profile (#82). Pages the
 * installed app cached still link here, so it stays, as a redirect.
 */
export const LEGACY_MANAGE_PATH = '/wardrobe-share/manage';

/**
 * An invite's landing page (public, its token a bearer secret: the route is
 * `secretPath`), and where signing in from it returns (#661).
 */
export function invitePath(token: string): string {
  return `/wardrobe-share/invite/${encodeURIComponent(token)}`;
}

/** Profile's query parameter naming why an invite could not be accepted. */
export const SHARE_ERROR_PARAM = 'shareError';

export function sharingRefusalUrl(refusal: AcceptRefusal): string {
  return `${PROFILE_PATH}?${SHARE_ERROR_PARAM}=${refusal}#${SHARING_SECTION_ID}`;
}
