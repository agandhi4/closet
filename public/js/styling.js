/**
 * Styling's strips (src/web/styling/styling-row.tsx, #42): which garment a
 * row holds is the one scrolled to its centre. Swiping is the browser's
 * own scroll-snap, so there are no touch handlers here at all; an
 * IntersectionObserver per strip, rooted on the strip with its margins
 * pulled in to a line down the middle, says which item crosses that line,
 * and that item becomes the row's choice: its `garmentId` field (what Save
 * and Shuffle post), `data-selected` and `aria-selected`.
 *
 * - initStyling(root) centres each strip on its chosen item and starts
 *   watching it. The page's inline module calls it on every visit (a
 *   boosted navigation brings new rows); htmx:load covers rows swapped in
 *   later (Shuffle, "Add row", a strip's next page) and a history restore,
 *   whose snapshot keeps the chosen item marked. Calling it twice on a
 *   strip is harmless.
 * - A tap on a neighbour centres it instead of opening it; a tap on the
 *   chosen garment opens its page (a boosted link).
 * - A locked row is frozen (#106): CSS stops its strip scrolling under a
 *   finger (styling-row.tsx), and a tap on a neighbour does nothing, since
 *   a script's scroll would still move it. Centring on load still runs, so
 *   a row opened locked ("Style this") sits on its garment.
 *
 * Evaluated once per document: the listeners below sit on the document and
 * serve every page's rows.
 */

/** Strips already watched, each with its observer. */
const watched = new WeakMap();

export function initStyling(root) {
  if (!root) return;
  for (const strip of root.querySelectorAll('.styling-strip')) watch(strip);
}

function watch(strip) {
  let observer = watched.get(strip);
  if (!observer) {
    centre(strip, strip.querySelector('[data-selected]'), 'instant');
    observer = new IntersectionObserver((entries) => chooseFrom(strip, entries), {
      root: strip,
      // A zero-width band down the middle: an item intersects it only while
      // it covers the centre, which is where scroll-snap parks the choice.
      rootMargin: '0px -50% 0px -50%',
      threshold: 0,
    });
    watched.set(strip, observer);
  }
  // A strip's next page arrives as new items: observing one twice is a no-op.
  for (const item of strip.querySelectorAll('.styling-item')) {
    observer.observe(item);
  }
}

function chooseFrom(strip, entries) {
  const crossing = entries.find((entry) => entry.isIntersecting);
  if (crossing) choose(strip, crossing.target);
}

function choose(strip, item) {
  const row = strip.closest('[data-styling-row]');
  const field = row?.querySelector('input[name="garmentId"]');
  if (!field) return;
  // A hidden input's value is its attribute, so htmx's history snapshot
  // keeps the choice too.
  field.value = item.dataset.garmentId;
  for (const other of strip.querySelectorAll('.styling-item')) {
    const chosen = other === item;
    other.toggleAttribute('data-selected', chosen);
    other.setAttribute('aria-selected', String(chosen));
  }
}

/** The row's lock, the same state the strip's CSS freezes on. */
function isLocked(strip) {
  return Boolean(
    strip.closest('[data-styling-row]')?.querySelector('.styling-lock:checked'),
  );
}

/** Scrolls `item` to the middle of its strip. */
function centre(strip, item, behavior) {
  if (!item) return;
  const left = item.offsetLeft - (strip.clientWidth - item.offsetWidth) / 2;
  strip.scrollTo({ left, behavior });
}

function smooth() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 'instant'
    : 'smooth';
}

// A neighbour peeking at the edge: a tap brings it to the middle (and so
// chooses it); only the chosen garment's tap opens its page. In the capture
// phase: a garment is a boosted link, and htmx's own click listener on it
// would start the navigation before a listener on the document heard the
// click bubble up.
document.addEventListener(
  'click',
  (event) => {
    const item = event.target.closest('.styling-item');
    if (!item || item.hasAttribute('data-selected')) return;
    const strip = item.closest('.styling-strip');
    if (!strip) return;
    event.preventDefault();
    event.stopPropagation();
    if (isLocked(strip)) return;
    centre(strip, item, smooth());
  },
  { capture: true },
);

// Rows swapped in after the page loaded, and history restores.
document.addEventListener('htmx:load', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const strip = target.closest('.styling-strip');
  if (strip) watch(strip);
  else initStyling(target);
});
