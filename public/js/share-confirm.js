/**
 * The share confirmation (#22d; GET /inspiration/share/confirm,
 * src/web/inspiration/share-confirm-page.tsx, which loads this through
 * the importmap). Why a module: the shared photo is on the device, in the
 * Cache Storage entry the service worker kept it under
 * (src/web/inspiration/share-target.ts). The worker never posts a share to
 * the server, since a cross-site page can submit the same share, so the
 * server cannot render the photo; the page's data attributes name the
 * stash, so its names live in that one TS module.
 *
 * The URL's fragment is the stash's id. A share found, and younger than
 * its age, goes into the form's file input (prepared like a chosen photo:
 * photo-input's preparePhoto), is shown, and Save look is enabled. The
 * form's own native post to POST /inspiration is the only write. Save and
 * Cancel delete the share; one past its age is deleted when read and shown
 * as gone, like one that is not there.
 */
import { preparePhoto } from 'photo-input';

/** Shows the element for `state` (none for a ready share), hides the rest. */
function show(root, state) {
  for (const el of root.querySelectorAll('[data-share-state]')) {
    el.classList.toggle('hidden', el.dataset.shareState !== state);
  }
}

/**
 * Save look, enabled, unless the page is offline right now: then it is left
 * to the offline guard (public/js/connectivity.js), marked as one it
 * disabled, so it is enabled with the guard's others on reconnecting. The
 * guard skips a control already disabled, which this one was until now.
 */
function enable(button) {
  const connectivity = document.documentElement.dataset.connectivity;
  if (connectivity && connectivity !== 'online') {
    button.dataset.offlineDisabled = '';
    button.setAttribute('aria-disabled', 'true');
    return;
  }
  button.disabled = false;
}

/**
 * The share stashed under `id`, as a File, and how to delete it; undefined
 * when there is none, or it is past its age (deleted then).
 */
async function readShare(root, id) {
  const {
    stashCache,
    stashKeyPrefix,
    stashMaxAgeMs,
    sharedAtHeader,
    sharedNameHeader,
  } = root.dataset;
  const cache = await caches.open(stashCache);
  const key = `${stashKeyPrefix}${encodeURIComponent(id)}`;
  const response = await cache.match(key);
  if (!response) return undefined;
  const sharedAt = Number(response.headers.get(sharedAtHeader));
  if (!(Date.now() - sharedAt < Number(stashMaxAgeMs))) {
    await cache.delete(key);
    console.info('[share] the shared photo was past its age: deleted');
    return undefined;
  }
  // The bytes copied out of the entry, so deleting it as the form posts
  // cannot take the file's data with it.
  const file = new File(
    [await response.arrayBuffer()],
    decodeURIComponent(response.headers.get(sharedNameHeader) ?? '') ||
      'shared-photo',
    { type: response.headers.get('Content-Type') ?? '' },
  );
  return { file, discard: () => cache.delete(key) };
}

/** @param {HTMLElement | null} root the page's #share-confirm */
export async function confirmShare(root) {
  if (!root) return;
  const id = location.hash.slice(1);
  if (id === root.dataset.tooLarge) {
    show(root, root.dataset.tooLarge);
    console.info('[share] the shared photo was too large to keep');
    return;
  }
  let share;
  try {
    if (id && 'caches' in window) share = await readShare(root, id);
  } catch (err) {
    console.warn('[share] could not read the shared photo', err);
  }
  if (!share) {
    show(root, 'missing');
    console.info('[share] no shared photo to confirm');
    return;
  }
  const form = root.closest('form');
  const input = root.querySelector('input[type=file]');
  const transfer = new DataTransfer();
  transfer.items.add(share.file);
  input.files = transfer.files;
  const photo = await preparePhoto(input);
  const preview = root.querySelector('[data-share-preview]');
  preview.src = URL.createObjectURL(photo);
  preview.classList.remove('hidden');
  show(root, 'ready');
  enable(form.querySelector('button[type=submit]'));
  const discard = () => void share.discard();
  form.addEventListener('submit', discard);
  form.querySelector('[data-history-back]')?.addEventListener('click', discard);
  console.info(`[share] shared photo ready to save (${photo.size} B)`);
}
