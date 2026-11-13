import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  receiveShare,
  SHARE_BODY_MAX_BYTES,
  SHARE_PHOTO_MAX_BYTES,
  SHARE_STASH_CACHE,
  SHARE_STASH_KEY_PREFIX,
  SHARED_AT_HEADER,
  SHARED_NAME_HEADER,
  SHARED_TITLE_HEADER,
  SHARED_URL_HEADER,
  type ShareStashStorage,
} from './share-target';
import { LINK_INPUT_MAX } from '../wardrobe/link-import/link-text';

const ORIGIN = 'https://closet.test';
const NOW = 1_800_000_000_000;

/** Cache Storage as the worker has it: named caches of keyed responses. */
function fakeCaches() {
  const caches = new Map<string, Map<string, Response>>();
  const storage: ShareStashStorage = {
    open: (name) => {
      const cache = caches.get(name) ?? new Map<string, Response>();
      caches.set(name, cache);
      return Promise.resolve({
        // The stash keys by URL string (SHARE_STASH_KEY_PREFIX + id).
        put: (key: RequestInfo | URL, response: Response) => {
          cache.set(
            key instanceof Request ? key.url : key.toString(),
            response,
          );
          return Promise.resolve();
        },
      });
    },
    delete: (name) => Promise.resolve(caches.delete(name)),
  };
  /** The stash's keys, and the response under `id`. */
  const stashed = () => [...(caches.get(SHARE_STASH_CACHE)?.keys() ?? [])];
  const kept = (id: string) =>
    caches.get(SHARE_STASH_CACHE)?.get(`${SHARE_STASH_KEY_PREFIX}${id}`);
  return { storage, caches, stashed, kept };
}

/** The stash id a 303 to the confirmation page names in its fragment. */
const idIn = (response: Response) =>
  new URL(response.headers.get('Location') ?? '').hash.slice(1);

/** The share target's POST navigation, as Android sends it (multipart). */
function shareRequest(
  fields: Record<string, string>,
  files: File[] = [],
): Request {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  for (const file of files) form.append('photo', file);
  return new Request(`${ORIGIN}/inspiration/share`, {
    method: 'POST',
    body: form,
  });
}

const jpeg = (name = 'look.jpg', bytes = 16) =>
  new File([new Uint8Array(bytes).fill(7)], name, { type: 'image/jpeg' });

// The share target's handler (#22d) runs in the service worker
// (views/assets/src-sw.ts) and never posts to the server: a cross-site page
// can submit the same navigation, and the worker cannot tell them apart.
// The confirmation page's own post is the only write (inspiration.spec.ts).
describe('receiveShare', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the first photo on the device and answers a 303 to the confirmation, its id the fragment', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const { storage, stashed, kept } = fakeCaches();
    const { outcome, response } = await receiveShare(
      shareRequest({ title: 'A look', text: 'https://shop.test/look' }, [
        jpeg('first look.jpg'),
        jpeg('second.jpg'),
      ]),
      storage,
      NOW,
    );
    expect(outcome).toBe('stashed');
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('Location') ?? '');
    expect(`${location.origin}${location.pathname}${location.search}`).toBe(
      `${ORIGIN}/inspiration/share/confirm`,
    );
    const id = idIn(response);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(stashed()).toEqual([`${SHARE_STASH_KEY_PREFIX}${id}`]);
    const photo = kept(id)!;
    expect(Object.fromEntries(photo.headers)).toMatchObject({
      'content-type': 'image/jpeg',
      [SHARED_AT_HEADER.toLowerCase()]: String(NOW),
      [SHARED_NAME_HEADER.toLowerCase()]: encodeURIComponent('first look.jpg'),
    });
    expect((await photo.arrayBuffer()).byteLength).toBe(16);
    expect(fetch).not.toHaveBeenCalled();
  });

  // The confirmation posts them with the photo, so the look keeps its source.
  it('keeps the link and title beside the photo, the link read like a link share', async () => {
    const { storage, kept } = fakeCaches();
    const { response } = await receiveShare(
      shareRequest(
        {
          title: ' Linen suit ',
          text: 'Look: https://shop.test/look?a=1&b=2.',
        },
        [jpeg()],
      ),
      storage,
      NOW,
    );
    const headers = kept(idIn(response))!.headers;
    expect(headers.get(SHARED_URL_HEADER)).toBe(
      encodeURIComponent('https://shop.test/look?a=1&b=2'),
    );
    expect(headers.get(SHARED_TITLE_HEADER)).toBe(
      encodeURIComponent('Linen suit'),
    );
    const bare = await receiveShare(
      shareRequest({ text: 'no link' }, [jpeg()]),
      storage,
      NOW,
    );
    const none = kept(idIn(bare.response))!.headers;
    expect(none.has(SHARED_URL_HEADER)).toBe(false);
    expect(none.has(SHARED_TITLE_HEADER)).toBe(false);
  });

  it('cuts a long title on a code point, so the header still encodes and the photo is kept', async () => {
    const { storage, kept } = fakeCaches();
    // The emoji's pair straddles the cap.
    const title = `${'a'.repeat(LINK_INPUT_MAX - 1)}\u{1F457}`;
    const { response } = await receiveShare(
      shareRequest({ title }, [jpeg()]),
      storage,
      NOW,
    );
    expect(response.headers.get('location')).toContain('#');
    expect(kept(idIn(response))!.headers.get(SHARED_TITLE_HEADER)).toBe(
      'a'.repeat(LINK_INPUT_MAX - 1),
    );
  });

  // POST /inspiration refuses these (isStorableLink): the photo is kept, the link dropped.
  it.each([
    ['a link that does not parse', 'https://'],
    [
      'a link past LINK_INPUT_MAX',
      `https://shop.test/${'a'.repeat(LINK_INPUT_MAX)}`,
    ],
  ])('keeps the photo but not %s', async (_case, link) => {
    const { storage, kept } = fakeCaches();
    const { response } = await receiveShare(
      shareRequest({ url: link, title: 'Suit' }, [jpeg()]),
      storage,
      NOW,
    );
    const headers = kept(idIn(response))!.headers;
    expect(headers.has(SHARED_URL_HEADER)).toBe(false);
    expect(headers.get(SHARED_TITLE_HEADER)).toBe('Suit');
  });

  it('refuses a body declared past the cap before reading it', async () => {
    const { storage, caches } = fakeCaches();
    const declared = new Request(shareRequest({}, [jpeg()]), {
      headers: { 'Content-Length': String(SHARE_BODY_MAX_BYTES + 1) },
    });
    const read = vi.spyOn(declared, 'formData');
    const { outcome, response } = await receiveShare(declared, storage, NOW);
    expect(outcome).toBe('too-large');
    expect(response.headers.get('Location')).toBe(
      `${ORIGIN}/inspiration/share/confirm#too-large`,
    );
    expect(read).not.toHaveBeenCalled();
    expect(caches.size).toBe(0);
  });

  it('keeps one share at a time: a new one replaces the last', async () => {
    const { storage, stashed } = fakeCaches();
    await receiveShare(shareRequest({}, [jpeg()]), storage, NOW);
    const second = await receiveShare(shareRequest({}, [jpeg()]), storage, NOW);
    expect(stashed()).toEqual([
      `${SHARE_STASH_KEY_PREFIX}${idIn(second.response)}`,
    ]);
  });

  it('keeps no photo past the cap, and says so on the confirmation page', async () => {
    const { storage, caches } = fakeCaches();
    const { outcome, response } = await receiveShare(
      shareRequest({}, [jpeg('huge.jpg', SHARE_PHOTO_MAX_BYTES + 1)]),
      storage,
      NOW,
    );
    expect(outcome).toBe('too-large');
    expect(response.headers.get('Location')).toBe(
      `${ORIGIN}/inspiration/share/confirm#too-large`,
    );
    expect(caches.size).toBe(0);
  });

  it('sends the confirmation page nothing when the device cannot keep the photo', async () => {
    const { storage } = fakeCaches();
    const full: ShareStashStorage = {
      ...storage,
      open: () =>
        Promise.resolve({
          put: () =>
            Promise.reject(new DOMException('full', 'QuotaExceededError')),
        }),
    };
    const { outcome, response } = await receiveShare(
      shareRequest({}, [jpeg()]),
      full,
      NOW,
    );
    expect(outcome).toBe('unstored');
    expect(response.headers.get('Location')).toBe(
      `${ORIGIN}/inspiration/share/confirm`,
    );
  });

  it.each([
    [
      'a link, in text after a title',
      { title: 'Shop', text: 'Look: https://shop.test/look' },
      [],
      'link',
      '/wardrobe/new/from-link?url=https%3A%2F%2Fshop.test%2Flook',
    ],
    [
      'a link, in url',
      { url: 'https://shop.test/look' },
      [],
      'link',
      '/wardrobe/new/from-link?url=https%3A%2F%2Fshop.test%2Flook',
    ],
    [
      'a file that is not an image, with a link',
      { url: 'https://shop.test/look' },
      [new File(['%PDF'], 'look.pdf', { type: 'application/pdf' })],
      'link',
      '/wardrobe/new/from-link?url=https%3A%2F%2Fshop.test%2Flook',
    ],
    [
      'text without a link',
      { text: 'no link here' },
      [],
      'text',
      '/wardrobe/new/from-link?text=no+link+here',
    ],
    [
      'text without a link, cut to the link field',
      { text: 'word '.repeat(2000) },
      [],
      'text',
      `/wardrobe/new/from-link?text=${'word+'.repeat(819)}w`,
    ],
    ['nothing', {}, [], 'text', '/wardrobe/new/from-link'],
  ] as const)(
    'sends a share without a photo to the link page, keeping nothing: %s',
    async (_case, fields, files, outcome, location) => {
      const fetch = vi.spyOn(globalThis, 'fetch');
      const { storage, caches } = fakeCaches();
      const received = await receiveShare(
        shareRequest(fields, [...files]),
        storage,
        NOW,
      );
      expect(received.outcome).toBe(outcome);
      expect(received.response.status).toBe(303);
      expect(received.response.headers.get('Location')).toBe(
        `${ORIGIN}${location}`,
      );
      expect(caches.size).toBe(0);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('answers a body that is not a form with the confirmation page, keeping nothing', async () => {
    const { storage, caches } = fakeCaches();
    const { outcome, response } = await receiveShare(
      new Request(`${ORIGIN}/inspiration/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
      storage,
      NOW,
    );
    expect(outcome).toBe('unreadable');
    expect(response.headers.get('Location')).toBe(
      `${ORIGIN}/inspiration/share/confirm`,
    );
    expect(caches.size).toBe(0);
  });
});
