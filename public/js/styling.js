/**
 * Styling's rows (src/web/styling/styling-row.tsx, #42) are snap strips: the
 * shared observer (snap-strip.js) centres the chosen item, chooses the one
 * scrolled to the middle into the row's `garmentId` and centres a tapped
 * neighbour. This module is what is Styling's own: the row locks.
 *
 * - initStyling(root) is the page's inline module's one call: it loads these
 *   listeners and starts the strips under `root` (see initSnapStrips).
 * - A locked row is frozen (#106): CSS stops its strip scrolling under a
 *   finger (styling-row.tsx), its neighbours are inert (#146: out of the tab
 *   order, the accessibility tree and hit testing, so neither Tab nor a tap
 *   reaches one), and whatever else scrolls it is undone rather than
 *   chosen. Centring on load still runs (the shared observer), so a row
 *   opened locked ("Style this") sits on its garment. The server renders a
 *   locked row's inert neighbours; setLocked owns every change after that
 *   (the lock's field, its attribute and the neighbours), and a strip's
 *   next page is made inert as it lands in a locked row (`snap-strip:watch`).
 *
 * Evaluated once per document: the listeners below sit on the document and
 * serve every page's rows.
 */
import { centre, initSnapStrips } from 'snap-strip';

export function initStyling(root) {
  initSnapStrips(root);
}

// A locked row keeps its garment whatever moved the strip. Its hidden
// overflow stops fingers and wheels and its inert neighbours take no
// focus, but a script's scroll still moves it (scrollIntoView, or a
// browser revealing a focused descendant, as Firefox did before #146), so
// cancel the choice and put it back in the middle instead.
document.addEventListener('snap-strip:choose', (event) => {
  const strip = event.target;
  if (!strip.matches('.styling-strip') || !rowLocked(rowOf(strip))) return;
  event.preventDefault();
  if (!event.detail.item.hasAttribute('data-selected')) {
    centre(strip, strip.querySelector('[data-selected]'), 'instant');
  }
});

// The next page's request does not carry the row's lock.
document.addEventListener('snap-strip:watch', (event) => {
  const strip = event.target;
  if (strip.matches('.styling-strip')) syncLock(rowOf(strip));
});

function rowOf(element) {
  return element.closest('[data-styling-row]');
}

/** The row's lock, the same state the strip's CSS freezes on. */
function rowLocked(row) {
  return row.querySelector('.styling-lock:checked') !== null;
}

/**
 * A locked row's neighbours are inert, its chosen item is not; unlocked,
 * none is. The `inert` property reflects to its attribute, so htmx's
 * history snapshot (innerHTML) keeps it.
 */
function syncLock(row) {
  const locked = rowLocked(row);
  for (const item of row.querySelectorAll('.styling-item')) {
    item.inert = locked && !item.hasAttribute('data-selected');
  }
}

/**
 * The lock was toggled: the row's `lock` field (what Shuffle and Save
 * post), the checkbox's `checked` attribute (htmx's history snapshot is
 * innerHTML, which drops the property) and its neighbours' inert, together.
 */
function setLocked(lock) {
  const row = rowOf(lock);
  row.querySelector('input[name="lock"]').value = lock.checked ? '1' : '';
  lock.toggleAttribute('checked', lock.checked);
  syncLock(row);
  console.debug(
    `[styling] ${row.dataset.stylingRow} row ${lock.checked ? 'locked' : 'unlocked'}`,
  );
}

document.addEventListener('change', (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.matches('.styling-lock')) {
    setLocked(target);
  }
});
