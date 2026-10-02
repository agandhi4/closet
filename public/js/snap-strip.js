/**
 * The snap strip's observer (src/web/strip/snap-strip.tsx): which item a
 * strip holds is the one scrolled to its centre. Swiping is the browser's
 * own scroll-snap, so there are no touch handlers here at all; an
 * IntersectionObserver per strip, rooted on the strip with its margins
 * pulled in to a line down the middle, says which item crosses that line,
 * and that item becomes the choice: its `data-snap-value` goes into the
 * strip's hidden input (the element right after the strip),
 * and `data-selected` and `aria-selected` move to it.
 *
 * - initSnapStrips(root) centres each strip on its `data-selected` item and
 *   starts watching it. A page's inline module calls it on every visit (a
 *   boosted navigation brings new strips; a <script src> module would run
 *   once per document); htmx:load covers strips swapped in later and a
 *   history restore, whose snapshot keeps the chosen item marked. Calling it
 *   twice on a strip is harmless, and a strip's next page (new items in a
 *   watched strip) is observed as it lands.
 * - A tap on a neighbour centres it (and so chooses it) instead of opening
 *   it; a tap on the chosen item behaves as the item does (a boosted link
 *   opens).
 * - A page with rules of its own listens on the document, nothing else:
 *   `snap-strip:choose` (cancelable, on the strip, detail.item) before an
 *   item is chosen, cancelled to keep the choice as it is; `snap-strip:watch`
 *   (on the strip) after it has been (re)scanned. Styling's locks use both.
 *
 * Evaluated once per document: the listeners below sit on the document and
 * serve every page's strips.
 */

/** Strips already watched, each with its observer. */
const watched = new WeakMap();

export function initSnapStrips(root) {
  if (!root) return;
  for (const strip of root.querySelectorAll('[data-snap-strip]')) watch(strip);
}

function watch(strip) {
  let observer = watched.get(strip);
  if (!observer) {
    centre(strip, strip.querySelector('[data-selected]'), 'instant');
    observer = new IntersectionObserver(
      (entries) => chooseFrom(strip, entries),
      {
        root: strip,
        // A zero-width band down the middle: an item intersects it only while
        // it covers the centre, which is where scroll-snap parks the choice.
        rootMargin: '0px -50% 0px -50%',
        threshold: 0,
      },
    );
    watched.set(strip, observer);
  }
  // A strip's next page arrives as new items: observing one twice is a no-op.
  for (const item of strip.querySelectorAll('[data-snap-item]')) {
    observer.observe(item);
  }
  strip.dispatchEvent(new CustomEvent('snap-strip:watch', { bubbles: true }));
}

function chooseFrom(strip, entries) {
  const crossing = entries.find((entry) => entry.isIntersecting);
  if (!crossing) return;
  const proceed = strip.dispatchEvent(
    new CustomEvent('snap-strip:choose', {
      bubbles: true,
      cancelable: true,
      detail: { item: crossing.target },
    }),
  );
  if (proceed) choose(strip, crossing.target);
}

function choose(strip, item) {
  // SnapStrip emits its input directly after the strip, so strips sharing a
  // container each write to their own.
  const field = strip.nextElementSibling;
  if (!(field instanceof HTMLInputElement)) {
    throw new Error('snap-strip: the strip is not followed by its input');
  }
  // A hidden input's value is its attribute, so htmx's history snapshot
  // keeps the choice too.
  field.value = item.dataset.snapValue;
  for (const other of strip.querySelectorAll('[data-snap-item]')) {
    const chosen = other === item;
    other.toggleAttribute('data-selected', chosen);
    other.setAttribute('aria-selected', String(chosen));
  }
}

/** Scrolls `item` to the middle of its strip. */
export function centre(strip, item, behavior) {
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
// chooses it); only the chosen item's tap reaches the item. In the capture
// phase: an item may be a boosted link, and htmx's own click listener on it
// would start the navigation before a listener on the document heard the
// click bubble up. A page that makes neighbours inert (Styling's locked
// rows) gets no click on them at all: it lands on the strip.
document.addEventListener(
  'click',
  (event) => {
    const item = event.target.closest('[data-snap-item]');
    if (!item || item.hasAttribute('data-selected')) return;
    const strip = item.closest('[data-snap-strip]');
    if (!strip) return;
    event.preventDefault();
    event.stopPropagation();
    centre(strip, item, smooth());
  },
  { capture: true },
);

// Strips swapped in after the page loaded, and history restores.
document.addEventListener('htmx:load', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const strip = target.closest('[data-snap-strip]');
  if (strip) watch(strip);
  else initSnapStrips(target);
});
