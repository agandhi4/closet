/**
 * Active connectivity detection (frontend-pwa.md): the app is online when
 * GET /healthz answers, not when navigator.onLine says so (captive portals,
 * VPNs and routers without uplink all report true). Probes every 30 s while
 * the tab is visible, immediately after any failed htmx request, and every
 * 5 s while offline.
 *
 * Owns #connectivity-banner (src/web/layout/app-status.tsx): a persistent
 * "offline" banner, "reconnecting" while a retry is in flight, and a short
 * toast when the server answers again. Loaded by the layout on every page,
 * with or without a service worker.
 */
import { showToast } from 'toast';

const HEARTBEAT_MS = 30_000;
const RETRY_MS = 5_000;
const PROBE_TIMEOUT_MS = 5_000;
const BACK_ONLINE_TOAST_MS = 3_000;

/** @type {'online' | 'offline' | 'reconnecting'} */
let state = 'online';
let timer = null;
let inFlight = null;

const strings = () => document.getElementById('app-status')?.dataset ?? {};

function render() {
  const banner = document.getElementById('connectivity-banner');
  if (!banner) return;
  const text = banner.querySelector('[data-role="text"]');
  if (state === 'online') {
    banner.classList.add('hidden');
    return;
  }
  text.textContent =
    state === 'offline' ? strings().textOffline : strings().textReconnecting;
  banner.classList.remove('hidden');
}

function setState(next) {
  if (next === state) return;
  const previous = state;
  state = next;
  console.info(`[connectivity] ${previous} -> ${next}`);
  document.dispatchEvent(
    new CustomEvent('connectivity:change', { detail: { state, previous } }),
  );
  render();
  if (next === 'online' && previous !== 'online') {
    showToast({
      text: strings().textBackOnline,
      kind: 'success',
      ttlMs: BACK_ONLINE_TOAST_MS,
    });
  }
}

function schedule(delayMs) {
  clearTimeout(timer);
  timer = setTimeout(() => probe('timer'), delayMs);
}

async function serverReachable() {
  try {
    const res = await fetch('/healthz', {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** One probe at a time; concurrent callers share the result. */
export function probe(reason) {
  if (inFlight) return inFlight;
  if (state === 'offline') setState('reconnecting');
  inFlight = serverReachable().then((reachable) => {
    inFlight = null;
    setState(reachable ? 'online' : 'offline');
    if (document.visibilityState === 'visible') {
      schedule(reachable ? HEARTBEAT_MS : RETRY_MS);
    }
    return reachable;
  });
  if (reason !== 'timer') {
    console.debug(`[connectivity] probe (${reason})`);
  }
  return inFlight;
}

export const getState = () => state;

// Browser events are hints that something changed; the probe decides.
window.addEventListener('online', () => probe('online-event'));
window.addEventListener('offline', () => probe('offline-event'));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') probe('visible');
  else clearTimeout(timer);
});
// A request that never reached the server is the strongest offline signal.
document.addEventListener('htmx:sendError', () => probe('htmx:sendError'));
document.addEventListener('htmx:responseError', () =>
  probe('htmx:responseError'),
);
// hx-boost replaces the whole body, banner included.
document.addEventListener('htmx:afterSettle', render);

probe('load');
