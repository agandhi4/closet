import type { UnreadReason } from './writes';

/**
 * The Inspiration tab's addresses (#22), built from parsed values. Under
 * the Outfits section (sections.ts): a look is the start of an outfit.
 */

export const INSPIRATION_PATH = '/inspiration';
export const NEW_INSPIRATION_PATH = `${INSPIRATION_PATH}/new`;
export const INSPIRATION_LINK_PATH = `${INSPIRATION_PATH}/link`;

/** A look's page; `unread` says once why a link came without its photo. */
export function inspirationUrl(id: number, unread?: UnreadReason): string {
  const path = `${INSPIRATION_PATH}/${id}`;
  return unread ? `${path}?unread=${unread}` : path;
}

export function inspirationPhotoPath(id: number): string {
  return `${INSPIRATION_PATH}/${id}/photo`;
}

export function deleteInspirationPath(id: number): string {
  return `${INSPIRATION_PATH}/${id}/delete`;
}
