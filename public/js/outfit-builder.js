/**
 * The outfit builder's client side (src/web/outfits/form-page.tsx and
 * outfit-row.tsx): drag to reorder, swipe a row to step through its
 * category, the garment detail dialog, and clearing "Add row" after it adds
 * one. Everything else is htmx: the ‹ › arrows and "Add row" fetch
 * GET /outfits/row-fragment, and the server works out every index.
 *
 * Imported through the importmap by the form page's inline module, which
 * calls initOutfitBuilder on every visit (a boosted navigation brings a new
 * list). This module itself is evaluated once per document, so the
 * listeners below are registered once, on the document, and serve every row
 * htmx swaps in later.
 */
import Sortable from 'sortablejs';

/** A horizontal move at least this long (CSS px) is a swipe. */
const SWIPE_MIN = 30;

export function initOutfitBuilder(list) {
  Sortable.create(list, {
    handle: '.drag-handle',
    animation: 150,
    ghostClass: 'opacity-40',
  });
}

// Swipe left/right steps to the next/previous garment, like › and ‹. The
// rows are `touch-action: pan-y`, so the browser leaves horizontal moves to
// this and both listeners can be passive: vertical scrolling never waits on
// script. A touch that starts on the drag handle is Sortable's.
let swipe = null;

document.addEventListener(
  'touchstart',
  (event) => {
    const row = event.target.closest('.outfit-row');
    swipe =
      row && !event.target.closest('.drag-handle') && event.touches.length === 1
        ? {
            row,
            x: event.touches[0].clientX,
            y: event.touches[0].clientY,
          }
        : null;
  },
  { passive: true },
);

document.addEventListener(
  'touchend',
  (event) => {
    if (!swipe) return;
    const { row, x, y } = swipe;
    swipe = null;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - x;
    const dy = touch.clientY - y;
    if (Math.abs(dx) < SWIPE_MIN || Math.abs(dx) <= Math.abs(dy)) return;
    const index = dx < 0 ? row.dataset.nextIndex : row.dataset.prevIndex;
    const params = new URLSearchParams({ category: row.dataset.category, index });
    htmx.ajax('GET', `/outfits/row-fragment?${params}`, {
      target: row,
      swap: 'outerHTML',
    });
  },
  { passive: true },
);

// A row's garment button fills #garment-modal from its data attributes and
// opens it; the cutout is only fetched now, when the dialog shows it.
document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-garment-href]');
  if (!button) return;
  const garment = button.dataset;
  document.getElementById('modal-garment-link').href = garment.garmentHref;
  document.getElementById('modal-garment-name').textContent =
    garment.garmentName;
  const img = document.getElementById('modal-photo-img');
  img.src = garment.garmentPhoto || '';
  img.classList.toggle('hidden', !garment.garmentPhoto);
  document
    .getElementById('modal-photo-placeholder')
    .classList.toggle('hidden', !!garment.garmentPhoto);
  for (const [id, value] of [
    ['modal-brand', garment.garmentBrand],
    ['modal-color', garment.garmentColor],
    ['modal-size', garment.garmentSize],
    ['modal-notes', garment.garmentNotes],
  ]) {
    const line = document.getElementById(id);
    line.textContent = value || '';
    line.classList.toggle('hidden', !value);
  }
  document.getElementById('garment-modal').showModal();
});

// "Add row" is a GET form of its own (#add-row-form); once its row is in,
// the category box is cleared for the next one.
document.addEventListener('htmx:afterRequest', (event) => {
  if (event.target.id === 'add-row-form' && event.detail.successful) {
    event.target.reset();
  }
});
