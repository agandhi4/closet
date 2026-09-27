/**
 * The freshness indicator (frontend-pwa.md: reads render from cache with a
 * "last updated" timestamp). Started by pwa.js where there is a service
 * worker.
 *
 * What is on screen came from the network (live: nothing to say) or from a
 * cache: the service worker's (views/assets/src-sw.ts: a tab root opened
 * stale-while-revalidate, or any page whose network request timed out or
 * failed) or htmx's history snapshots. For a cached copy a minute old or
 * more, #freshness in the app bar says "Updated 3 minutes ago".
 *
 * A tab root's revalidation lands moments after it opens. When the server's
 * page differs it is swapped in at once if the page is untouched (no tap, key
 * or wheel yet, scrolled to the top, no dialog open); otherwise a toast
 * offers it ("Newer version of this page", Refresh), so content never moves
 * under a thumb or a half-typed form. When the session turned out to be gone
 * or to be another account's, the page reloads: what is on screen is not this
 * session's. Back online after showing a cached copy, the page asks for the
 * server's again and handles it the same way.
 */
import { ageLabel } from 'age-label';
import { showToast } from 'toast';

// Stamped by the worker on the copies it caches (src/web/page-cache.ts).
const CACHED_AT_HEADER = 'X-SW-Cached-At';
// Online, a revalidation lands within a few hundred ms: the age waits this
// long so a copy about to be replaced does not flash it.
const REVALIDATION_GRACE_MS = 1_000;
const TICK_MS = 30_000;

const strings = () => document.getElementById('app-status')?.dataset ?? {};
const pageUrl = () => location.href.split('#')[0];

/** The display on screen: replaced whenever the page or its URL changes. */
let display = newDisplay();

function newDisplay() {
  return {
    id: 0,
    url: pageUrl(),
    /** When the server produced what is on screen (epoch ms). */
    fetchedAt: Date.now(),
    fromCache: false,
    /** The age stays hidden until then, waiting for a revalidation. */
    quietUntil: 0,
    interacted: false,
    /** @type {{ dismiss: () => void } | null} */
    offer: null,
    /**
     * A fragment that pushed its URL (the wardrobe's filters): where it was
     * swapped and how, so a revalidation asks for the fragment again and
     * swaps the server's in the same way. Null for a whole page.
     * @type {{ targetId: string, swapStyle: string } | null}
     */
    fragment: null,
  };
}

function render() {
  const element = document.getElementById('freshness');
  if (!element) return;
  const label =
    display.fromCache && Date.now() >= display.quietUntil
      ? ageLabel(Date.now() - display.fetchedAt, document.documentElement.lang)
      : null;
  if (label) {
    element.textContent = (strings().textUpdatedAgo ?? '').replace(
      '{ago}',
      label,
    );
  }
  element.classList.toggle('hidden', !label);
}

/** Describes the display on screen (fetchedAt, fromCache, quietUntil). */
function update(fields) {
  Object.assign(display, fields);
  // In the body, so htmx's history snapshot of this page keeps it.
  const element = document.getElementById('freshness');
  if (element) element.dataset.fetchedAt = String(display.fetchedAt);
  render();
  const wait = display.quietUntil - Date.now();
  if (wait > 0) setTimeout(render, wait);
}

/** A new display: another page, or this one at another URL. */
function startDisplay(fields = {}) {
  display.offer?.dismiss();
  display = { ...newDisplay(), id: display.id + 1 };
  update(fields);
}

function fromResponse(xhr) {
  const cachedAt = Number(xhr.getResponseHeader(CACHED_AT_HEADER));
  return cachedAt > 0
    ? { fetchedAt: cachedAt, fromCache: true }
    : { fetchedAt: Date.now(), fromCache: false };
}

/**
 * A URL-pushing fragment's display: its target and the swap its requesting
 * element named. The layout turns htmx's inheritance off, so the element's
 * own hx-swap is the one htmx used; the element is read after the swap,
 * detached by an outerHTML swap, which keeps its attributes.
 */
function fragmentOf(target, requester) {
  const swap = requester.getAttribute('hx-swap');
  return {
    targetId: target.id,
    swapStyle: swap?.split(' ')[0] || window.htmx.config.defaultSwapStyle,
  };
}

const untouched = () =>
  !display.interacted &&
  window.scrollY === 0 &&
  !document.querySelector('dialog[open]');

/**
 * The server's page in place of the cached one, as a boosted navigation
 * would (htmx processes it; the target in the event detail tells pwa.js and
 * connectivity.js the body was swapped). A fragment goes back into its
 * target the way its request swapped it, out-of-band parts included.
 */
function swapIn(html, fields) {
  const { fragment } = display;
  const target = fragment
    ? document.getElementById(fragment.targetId)
    : document.body;
  window.htmx.swap(
    target,
    html,
    { swapStyle: fragment ? fragment.swapStyle : 'innerHTML' },
    { eventInfo: { target } },
  );
  startDisplay({ ...fields, fragment });
}

function onRevalidated(id, { outcome, html, fetchedAt }) {
  if (id !== display.id) return; // the user has moved on
  const path = location.pathname;
  if (outcome === 'current') {
    update({ fetchedAt, fromCache: false, quietUntil: 0 });
  } else if (outcome === 'updated' && untouched()) {
    console.info(`[freshness] ${path}: newer copy swapped in`);
    swapIn(html, { fetchedAt, fromCache: false });
  } else if (outcome === 'updated') {
    console.info(`[freshness] ${path}: newer copy offered`);
    update({ quietUntil: 0 });
    display.offer = showToast({
      text: strings().textNewerPage,
      kind: 'info',
      action: {
        label: strings().textRefresh,
        onClick: () => {
          if (id !== display.id) return;
          // Held since the revalidation: it says its age if that is long.
          swapIn(html, { fetchedAt, fromCache: true });
          window.scrollTo(0, 0);
        },
      },
    });
  } else if (outcome === 'signed-out' || outcome === 'account-changed') {
    // The worker has dropped every cached page; the reload asks the server.
    console.info(`[freshness] ${path}: ${outcome}, reloading`);
    location.reload();
  } else {
    update({ quietUntil: 0 }); // failed: the copy stays, and says its age
  }
}

/** Posts to the controlling worker; its answers come back on a port. */
function ask(message, onAnswer) {
  const worker = navigator.serviceWorker.controller;
  if (!worker) return;
  const channel = new MessageChannel();
  channel.port1.onmessage = (event) => onAnswer(event.data);
  worker.postMessage(message, [channel.port2]);
}

/** How this document was served: the worker's PAGE_FRESHNESS answers. */
function checkDocument() {
  const id = display.id;
  ask({ type: 'PAGE_FRESHNESS', url: display.url }, (answer) => {
    if (id !== display.id) return;
    if (answer.state === 'cached') {
      update({
        fetchedAt: answer.cachedAt,
        fromCache: true,
        quietUntil: answer.revalidating
          ? Date.now() + REVALIDATION_GRACE_MS
          : 0,
      });
    } else if (answer.state === 'revalidated') {
      onRevalidated(id, answer);
    }
  });
}

export function watchFreshness() {
  startDisplay();
  checkDocument();

  // Only what the user does counts, not a scroll the browser restores.
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    document.addEventListener(
      type,
      () => {
        display.interacted = true;
      },
      { capture: true, passive: true },
    );
  }

  // A boosted navigation swaps the body; a fragment that pushes a URL (the
  // wardrobe's filters, whose target has an id) is a new display too. Other
  // fragments are parts of this one. htmx's history swaps and swapIn carry
  // no xhr: handled below and in swapIn.
  document.addEventListener('htmx:afterSettle', (event) => {
    const { xhr, target, requestConfig } = event.detail;
    if (!xhr) return;
    const page = target === document.body;
    if (!page && pageUrl() === display.url) return;
    startDisplay({
      ...fromResponse(xhr),
      fragment: page ? null : fragmentOf(target, requestConfig.elt),
    });
  });

  // Back (or forward): htmx restores its snapshot of the page, which kept
  // its stamp, or fetches the page when it has none.
  let missed = null;
  document.addEventListener('htmx:historyCacheMissLoad', (event) => {
    missed = fromResponse(event.detail.xhr);
  });
  document.addEventListener('htmx:historyRestore', (event) => {
    if (event.detail.cacheMiss) {
      startDisplay(missed ?? {});
      missed = null;
      return;
    }
    const stamp = Number(
      document.getElementById('freshness')?.dataset.fetchedAt,
    );
    startDisplay({ fetchedAt: stamp || Date.now(), fromCache: true });
  });
  // The browser's back-forward cache is a cache too.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      startDisplay({ fetchedAt: display.fetchedAt, fromCache: true });
    }
  });

  // Back online (connectivity.js): a cached copy asks for the server's, a
  // fragment for the fragment (the worker keys it apart from the page).
  document.addEventListener('connectivity:change', (event) => {
    if (event.detail.state !== 'online' || !display.fromCache) return;
    const id = display.id;
    ask(
      {
        type: 'REVALIDATE_PAGE',
        url: display.url,
        fragment: display.fragment !== null,
      },
      (answer) => onRevalidated(id, answer),
    );
  });

  setInterval(render, TICK_MS);
  document.addEventListener('visibilitychange', render);
}
