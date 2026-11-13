import { LINK_INPUT_MAX, linkIn } from '../wardrobe/link-import/link-text';
import { LINK_IMPORT_PATH, wardrobeUrl } from '../wardrobe/urls';

/**
 * Android's share sheet into the installed app (#22d; the manifest's
 * target, src/web/shell/manifest.ts). The service worker answers the
 * share's POST navigation itself (receiveShare, from views/assets/src-sw.ts)
 * and **never sends it to the server**: the worker cannot tell Android's
 * share from a cross-site page auto-submitting the same form (neither has
 * a client id or an Origin it can read), and relaying either would post
 * with our Origin and the session's cookie, a CSRF bypass (docs/decisions.md
 * 2026-11-13). A shared photo is kept on the device and saved only by the
 * confirmation page's own native post to POST /inspiration; a share
 * without one goes on to the link page's GET, which saves nothing.
 *
 * This module imports only modules that import nothing: the worker's
 * bundle imports it, and the server (the manifest, the confirmation page).
 */
export const INSPIRATION_SHARE_PATH = '/inspiration/share';
/** The confirmation page (share-confirm-page.tsx); the stash id is its fragment. */
export const SHARE_CONFIRM_PATH = `${INSPIRATION_SHARE_PATH}/confirm`;
export const SHARE_PHOTO_FIELD = 'photo';
export const SHARED_TEXT_FIELDS = ['title', 'text', 'url'] as const;

/**
 * The largest shared photo kept, and the largest POST /inspiration takes:
 * a phone's camera photo is well under it.
 */
export const SHARE_PHOTO_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Where a shared photo waits for its confirmation: one Cache Storage
 * cache (a session cache, dropped with the worker's others) holding at most
 * one share, a new share replacing the last, under an off-origin key no
 * request can match. The confirmation page reads it (public/js/
 * share-confirm.js, which takes these from the page's data attributes).
 */
export const SHARE_STASH_CACHE = 'shares-v1';
export const SHARE_STASH_KEY_PREFIX = 'https://share-stash.invalid/';
/** A share older than this is gone: the page says so and deletes it. */
export const SHARE_STASH_MAX_AGE_MS = 60 * 60 * 1000;
/** Epoch ms the share was kept at, on the stashed response. */
export const SHARED_AT_HEADER = 'X-Shared-At';
/** The shared file's name, URI-encoded (a header holds no other text). */
export const SHARED_NAME_HEADER = 'X-Shared-Name';
/** The fragment the confirmation page reads as "too large to keep". */
export const SHARE_TOO_LARGE = 'too-large';

/** The part of CacheStorage the stash needs (the worker's `self.caches`). */
export interface ShareStashStorage {
  open(name: string): Promise<Pick<Cache, 'put'>>;
  delete(name: string): Promise<boolean>;
}

export type ShareOutcome =
  /** A photo, kept for the confirmation page. */
  | 'stashed'
  /** A photo past SHARE_PHOTO_MAX_BYTES, not kept. */
  | 'too-large'
  /** A photo the device could not keep (storage full, private mode). */
  | 'unstored'
  /** No photo: a link, to the link page. */
  | 'link'
  /** No photo and no link: the text, to the link page, which says so. */
  | 'text'
  /** A body that is not a form (the browser always sends one). */
  | 'unreadable';

export interface ReceivedShare {
  outcome: ShareOutcome;
  /** The navigation's answer: a 303, never anything the server sent. */
  response: Response;
}

/**
 * The share target's POST navigation, answered on the device. The first
 * file that declares an image type is the photo (a share of several keeps
 * one; anything else is not a photo); it is stashed under a random id and
 * the answer is a 303 to the confirmation page with the id as its
 * fragment, so it never reaches the server or its logs. Without a photo,
 * a 303 to the link page with the link alone (or the text cut to the
 * link field, so the page says it holds no link): never the whole text,
 * which a URL could not carry.
 */
export async function receiveShare(
  request: Request,
  storage: ShareStashStorage,
  now: number,
): Promise<ReceivedShare> {
  const answer = (outcome: ShareOutcome, path: string): ReceivedShare => ({
    outcome,
    response: Response.redirect(new URL(path, request.url).href, 303),
  });
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return answer('unreadable', SHARE_CONFIRM_PATH);
  }
  const photo = form
    .getAll(SHARE_PHOTO_FIELD)
    .find(
      (part): part is File =>
        typeof part !== 'string' && part.type.startsWith('image/'),
    );
  if (photo) {
    if (photo.size > SHARE_PHOTO_MAX_BYTES) {
      return answer('too-large', `${SHARE_CONFIRM_PATH}#${SHARE_TOO_LARGE}`);
    }
    const id = crypto.randomUUID();
    try {
      await stashPhoto(storage, id, photo, now);
    } catch {
      return answer('unstored', SHARE_CONFIRM_PATH);
    }
    return answer('stashed', `${SHARE_CONFIRM_PATH}#${id}`);
  }
  const field = (name: (typeof SHARED_TEXT_FIELDS)[number]) => {
    const value = form.get(name);
    return typeof value === 'string' ? value : '';
  };
  const shared = `${field('url')} ${field('text')}`.trim();
  const link = linkIn(shared);
  return answer(
    link ? 'link' : 'text',
    wardrobeUrl(
      undefined,
      link ? { url: link } : { text: shared.slice(0, LINK_INPUT_MAX) },
      LINK_IMPORT_PATH,
    ),
  );
}

/** One share at a time: the cache is emptied before this one goes in. */
async function stashPhoto(
  storage: ShareStashStorage,
  id: string,
  photo: File,
  now: number,
): Promise<void> {
  await storage.delete(SHARE_STASH_CACHE);
  const cache = await storage.open(SHARE_STASH_CACHE);
  await cache.put(
    `${SHARE_STASH_KEY_PREFIX}${id}`,
    new Response(photo, {
      headers: {
        'Content-Type': photo.type,
        [SHARED_AT_HEADER]: String(now),
        [SHARED_NAME_HEADER]: encodeURIComponent(photo.name),
      },
    }),
  );
}
