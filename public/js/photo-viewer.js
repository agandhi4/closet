/**
 * The shared photo viewer (src/web/files/photo-viewer.tsx, #313): one
 * document-level listener opens `<dialog id="photo-viewer">` for any element
 * carrying `data-photo-open="<set id>"` (and `data-photo-large`, the photo
 * it was tapped on). The set is the server's `<template data-photo-set>`; a
 * boosted navigation or an htmx swap needs no re-binding because nothing is
 * bound to the triggers.
 *
 * What the platform does not do alone, and so lives here: stepping and
 * keyboard arrows between slides (the row itself is native scroll-snap, so a
 * swipe needs no code), the zoom toggle (click on a mouse, double tap on
 * touch; pinch on the slide, below), swipe down to close, and loading each
 * slide's large image over the thumb the page already holds. Focus moving in
 * and Esc are showModal's; focus going back is restored here, as WebKit does
 * not focus a tapped button for the dialog to return to.
 *
 * Offline: the slide starts as the thumb (cached with the page) and only
 * swaps to the large image once it loads, so a cutout never viewed stays on
 * its thumb, as the garment page does (offline-warm.md).
 */

const DOUBLE_TAP_MS = 350;
const SWIPE_DOWN_PX = 90;
const MAX_ZOOM = 4;
const PAN_STEP_PX = 60;

const viewer = () => document.getElementById('photo-viewer');
const track = (dialog) => dialog.querySelector('[data-photo-track]');

let opener = null;
let slides = [];
let index = 0;
let lastTap = 0;
let frame = 0;
let zoom = 1;
const pointers = new Map();
let pinch = null;

function setSet(id) {
  const template = document.querySelector(
    `template[data-photo-set="${CSS.escape(id)}"]`,
  );
  return template ? [...template.content.querySelectorAll('img')] : [];
}

function buildSlide(source) {
  const slide = document.createElement('div');
  slide.className = 'photo-viewer-slide';
  const img = document.createElement('img');
  img.alt = source.alt;
  img.src = source.dataset.thumb;
  img.draggable = false;
  slide.append(img);
  slide.dataset.large = source.getAttribute('src');
  return slide;
}

/**
 * Swap a slide's thumb for the large image once that loads; keep the thumb
 * when it can't (offline), and say so rather than offer to zoom into it.
 */
function loadLarge(slide, dialog) {
  if (!slide || 'requested' in slide.dataset) return;
  slide.dataset.requested = '';
  const probe = new Image();
  probe.onload = () => {
    slide.querySelector('img').src = slide.dataset.large;
  };
  probe.onerror = () => {
    slide.dataset.thumbOnly = '';
    if (dialog.open && slides[index] === slide) {
      if (isZoomed()) setZoom(dialog, 1);
      showNotice(dialog);
    }
  };
  probe.src = slide.dataset.large;
}

/**
 * Zoom the current slide to `level` (1 = fitted), keeping `point` (client
 * coordinates; the centre when absent) under the finger.
 */
function setZoom(dialog, level, point) {
  const slide = slides[index];
  const row = track(dialog);
  const img = slide.querySelector('img');
  const rect = img.getBoundingClientRect();
  const frame = slide.getBoundingClientRect();
  const fx = point ? (point.x - rect.left) / rect.width : 0.5;
  const fy = point ? (point.y - rect.top) / rect.height : 0.5;
  const at = point
    ? { x: point.x - frame.left, y: point.y - frame.top }
    : { x: frame.width / 2, y: frame.height / 2 };
  zoom = Math.min(Math.max(level, 1), MAX_ZOOM);
  if (zoom < 1.02) zoom = 1;
  if (zoom > 1) {
    slide.style.setProperty('--photo-zoom', String(zoom));
    slide.dataset.zoomed = '';
    row.dataset.zoomed = '';
    slide.scrollLeft = fx * img.offsetWidth - at.x;
    slide.scrollTop = fy * img.offsetHeight - at.y;
  } else {
    slide.style.removeProperty('--photo-zoom');
    delete slide.dataset.zoomed;
    delete row.dataset.zoomed;
  }
  dialog
    .querySelector('[data-photo-zoom]')
    .setAttribute('aria-pressed', String(zoom > 1));
}

function isZoomed() {
  return zoom > 1;
}

/** The button/double-tap toggle: fitted to 2x and back. */
function toggleZoom(dialog, point) {
  if ('thumbOnly' in slides[index].dataset) return;
  setZoom(dialog, isZoomed() ? 1 : 2, point);
}

function showNotice(dialog) {
  const thumbOnly = 'thumbOnly' in slides[index].dataset;
  dialog.querySelector('[data-photo-notice]').textContent = thumbOnly
    ? dialog.dataset.textSmallerCopy
    : '';
  dialog.querySelector('[data-photo-zoom]').disabled = thumbOnly;
}

/** Disabling a focused button drops focus to the body: hand it on first. */
function keepFocus(dialog, disabling) {
  const focused = document.activeElement;
  if (!disabling.includes(focused)) return;
  const other = [...dialog.querySelectorAll('[data-photo-step]')].find(
    (button) => !disabling.includes(button),
  );
  (other ?? dialog.querySelector('[data-photo-close]')).focus();
}

function sync(dialog, next) {
  if (isZoomed()) setZoom(dialog, 1);
  index = next;
  for (const i of [next - 1, next, next + 1]) loadLarge(slides[i], dialog);
  const img = slides[next].querySelector('img');
  dialog.querySelector('[data-photo-caption]').textContent = img.alt;
  showNotice(dialog);
  dialog.querySelector('[data-photo-position]').textContent =
    dialog.dataset.textPosition
      .replace('{current}', String(next + 1))
      .replace('{total}', String(slides.length));
  const buttons = [...dialog.querySelectorAll('[data-photo-step]')];
  const off = (button) =>
    slides.length < 2 ||
    next + Number(button.dataset.photoStep) < 0 ||
    next + Number(button.dataset.photoStep) >= slides.length;
  keepFocus(dialog, buttons.filter(off));
  for (const button of buttons) {
    button.hidden = slides.length < 2;
    button.disabled = off(button);
  }
}

function step(dialog, by) {
  if (isZoomed()) setZoom(dialog, 1);
  const target = Math.min(Math.max(index + by, 0), slides.length - 1);
  if (target === index) return;
  const row = track(dialog);
  row.scrollTo({
    left: target * row.clientWidth,
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 'instant'
      : 'smooth',
  });
}

function open(trigger) {
  const dialog = viewer();
  if (!dialog || dialog.open) return;
  const sources = setSet(trigger.dataset.photoOpen);
  if (sources.length === 0) return;
  const start = sources.findIndex(
    (source) => source.getAttribute('src') === trigger.dataset.photoLarge,
  );
  if (start < 0) return;
  opener = trigger;
  const row = track(dialog);
  slides = sources.map(buildSlide);
  row.replaceChildren(...slides);
  row.addEventListener('touchmove', holdPinch, { passive: false });
  dialog.showModal();
  row.scrollTo({ left: start * row.clientWidth, behavior: 'instant' });
  sync(dialog, start);
}

document.addEventListener('click', (event) => {
  const trigger = event.target.closest('[data-photo-open]');
  if (trigger) {
    event.preventDefault();
    open(trigger);
    return;
  }
  const dialog = viewer();
  if (!dialog?.open || !dialog.contains(event.target)) return;
  if (event.target.closest('[data-photo-close]')) {
    dialog.close();
  } else if (event.target.closest('[data-photo-zoom]')) {
    toggleZoom(dialog);
  } else if (event.target.closest('[data-photo-step]')) {
    step(
      dialog,
      Number(event.target.closest('[data-photo-step]').dataset.photoStep),
    );
  } else if (event.target.closest('.photo-viewer-slide img')) {
    // A mouse click toggles; a touch needs a double tap, a single one being
    // the start of a swipe or pinch as far as the reader can tell.
    const point = { x: event.clientX, y: event.clientY };
    if (event.pointerType === 'touch') {
      const double = event.timeStamp - lastTap < DOUBLE_TAP_MS;
      lastTap = double ? 0 : event.timeStamp;
      if (!double) return;
    }
    toggleZoom(dialog, point);
  }
});

// A photo that is not a native button (a collage piece's <img role="button">).
document.addEventListener('keydown', (event) => {
  const dialog = viewer();
  if (dialog?.open && dialog.contains(event.target)) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const by = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (!by) return;
    // Zoomed, the arrows pan the photo; stepping needs it fitted again.
    if (isZoomed()) slides[index].scrollBy({ left: by * PAN_STEP_PX });
    else step(dialog, by);
    event.preventDefault();
    return;
  }
  const trigger = event.target.closest?.('[data-photo-open]');
  if (
    trigger &&
    trigger.tagName !== 'BUTTON' &&
    [' ', 'Enter'].includes(event.key)
  ) {
    event.preventDefault();
    open(trigger);
  }
});

// scroll and close do not bubble: capture them from the document.
document.addEventListener(
  'scroll',
  (event) => {
    const dialog = viewer();
    if (!dialog?.open || event.target !== track(dialog)) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const row = track(dialog);
      const current = Math.round(row.scrollLeft / row.clientWidth);
      if (current !== index && slides[current]) sync(dialog, current);
    });
  },
  true,
);

document.addEventListener(
  'close',
  (event) => {
    if (event.target.id !== 'photo-viewer') return;
    const dialog = event.target;
    track(dialog).removeEventListener('touchmove', holdPinch);
    track(dialog).replaceChildren();
    delete track(dialog).dataset.zoomed;
    slides = [];
    zoom = 1;
    pointers.clear();
    pinch = null;
    if (opener?.isConnected) opener.focus();
    opener = null;
  },
  true,
);

// Swipe down closes, unless the page is pinch-zoomed or a slide is.
let touchStart = null;
document.addEventListener(
  'touchstart',
  (event) => {
    const dialog = viewer();
    touchStart =
      dialog?.open &&
      event.touches.length === 1 &&
      dialog.contains(event.target)
        ? { x: event.touches[0].clientX, y: event.touches[0].clientY }
        : null;
  },
  { passive: true },
);
document.addEventListener(
  'touchend',
  (event) => {
    const dialog = viewer();
    if (!touchStart || !dialog?.open || isZoomed()) return;
    if ((window.visualViewport?.scale ?? 1) > 1.01) return;
    const touch = event.changedTouches[0];
    const dy = touch.clientY - touchStart.y;
    const dx = Math.abs(touch.clientX - touchStart.x);
    touchStart = null;
    if (dy > SWIPE_DOWN_PX && dx < dy * 0.5) dialog.close();
  },
  { passive: true },
);

// A phone's rotation changes the slide width: stay on the current photo.
function realign() {
  const dialog = viewer();
  if (!dialog?.open) return;
  const row = track(dialog);
  row.scrollTo({ left: index * row.clientWidth, behavior: 'instant' });
}
window.addEventListener('resize', realign);
window.addEventListener('orientationchange', realign);

// Pinch on the slide (Pointer Events): the browser's own pinch would zoom
// the page, which stays zoomable elsewhere, so the slides opt out of it in
// CSS and the zoom is driven here. A second finger starts it; the first
// alone is a swipe or pan, the browser's.
const distance = () => {
  const [a, b] = [...pointers.values()];
  return Math.hypot(a.x - b.x, a.y - b.y);
};
const midpoint = () => {
  const [a, b] = [...pointers.values()];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
};
// Two fingers on a slide are a pinch, never a scroll of the row beneath.
// Non-passive, so it sits on the track only while the viewer is open: on the
// document it would hold up every page's scrolling (test/styling.spec.ts).
const holdPinch = (event) => {
  if (event.touches.length === 2 && event.cancelable) event.preventDefault();
};

const onSlide = (event) =>
  viewer()?.open && event.target.closest?.('.photo-viewer-slide');

document.addEventListener('pointerdown', (event) => {
  if (event.pointerType !== 'touch' || !onSlide(event)) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pointers.size === 2 && !('thumbOnly' in slides[index].dataset)) {
    pinch = { start: distance(), zoom };
  }
});

document.addEventListener('pointermove', (event) => {
  if (!pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pinch && pointers.size === 2) {
    setZoom(viewer(), (pinch.zoom * distance()) / pinch.start, midpoint());
  }
});

for (const type of ['pointerup', 'pointercancel']) {
  document.addEventListener(type, (event) => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
  });
}
