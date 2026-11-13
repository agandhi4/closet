/**
 * The manifest's share target (#22d, src/web/shell/manifest.ts), which the
 * service worker relays to the server as the browser posted it: the shared
 * photo in the upload's own field (the one Photos.storeUploadParts reads),
 * or the shared text in the names the link import's GET reads too. A
 * module of its own, importing nothing, because the worker's bundle
 * imports it.
 */
export const INSPIRATION_SHARE_PATH = '/inspiration/share';
export const SHARE_PHOTO_FIELD = 'photo';
export const SHARED_TEXT_FIELDS = ['title', 'text', 'url'] as const;
export type SharedTextField = (typeof SHARED_TEXT_FIELDS)[number];
