/**
 * Select mode's "N selected" (SelectForm, src/web/wardrobe/wardrobe-page.tsx):
 * the boxes checked in the form, recounted on every toggle and whenever htmx
 * settles new content into it. The grid's next page arrives through the
 * sentinel's swap and fires no change event, yet the capsule picker renders
 * members on it checked, and Save posts them: the count must include them.
 *
 * Evaluated once per document: the listeners sit on the document and serve
 * every select-mode page a boosted navigation brings. The server renders the
 * first page's count, so nothing runs on load.
 */

const FORM = '[data-select-count]';

function recount(event) {
  const form = event.target instanceof Element && event.target.closest(FORM);
  if (!form) return;
  const count = form.querySelectorAll('input[name=ids]:checked').length;
  const shown = form.querySelector('[data-select-count-value]');
  if (shown) shown.textContent = String(count);
}

document.addEventListener('change', recount);
// Fired on each element a swap inserted, and bubbles to the form.
document.addEventListener('htmx:afterSettle', recount);
