/**
 * Installed-app plumbing, loaded by the layout when PWA_ENABLED: service
 * worker registration and the update flow, the freshness indicator of pages
 * served from the worker's cache (freshness.js), Web Push on signed-in pages
 * (push.js), the install dialog in a browser tab that can install the app,
 * and pull to refresh for iOS standalone (which has none of its own). Lives
 * in the head so hx-boost body swaps never re-run it; anything that touches
 * the body re-applies itself after a swap. The last two libraries are
 * imported only where they do something.
 *
 * Update flow (frontend-pwa.md, "never force-reload"): the worker in
 * views/assets/src-sw.ts no longer calls skipWaiting() on install, so a new
 * build sits in `waiting` until the user taps Reload. The toast then posts
 * SKIP_WAITING and this tab reloads on `controlling`. Other tabs keep their
 * page: the old hard-navigate-on-next-boosted-GET hack existed only because
 * the worker used to seize control mid-session; with the user choosing the
 * moment there is nothing to work around.
 */
import { Workbox } from 'workbox-window';
import { showToast } from 'toast';
import { watchFreshness } from 'freshness';

const strings = () => document.getElementById('app-status')?.dataset ?? {};

function registerServiceWorker() {
  const wb = new Workbox('/sw.js');
  let updateWaiting = false;
  let reloadRequested = false;
  let toast = null;

  const showUpdateToast = () => {
    toast?.dismiss();
    toast = showToast({
      text: strings().textUpdateAvailable,
      kind: 'info',
      action: {
        label: strings().textReload,
        onClick: () => {
          reloadRequested = true;
          console.info('[pwa] update accepted, activating new worker');
          wb.messageSkipWaiting();
        },
      },
    });
  };

  wb.addEventListener('waiting', () => {
    updateWaiting = true;
    console.info('[pwa] update waiting');
    showUpdateToast();
  });
  wb.addEventListener('controlling', (event) => {
    if (event.isUpdate && reloadRequested) window.location.reload();
  });
  // The toast lives in the body and is lost on every boosted navigation;
  // keep it until the user acts.
  document.addEventListener('htmx:afterSettle', () => {
    if (updateWaiting && !toast?.element.isConnected) showUpdateToast();
  });

  wb.register().then(() => console.info('[pwa] service worker registered'));
}

// The session cookie is httpOnly, so the layout says whether this page is
// signed in (data-signed-in on <html>). push.js defines the profile page's
// <push-settings> and re-sends an existing subscription; it never asks for
// permission by itself.
function startPush() {
  import('push')
    .then((push) => push.syncSubscription())
    .catch((error) => console.warn('[pwa] push sync failed', error));
}

// The <pwa-install> dialog (@khmyznikov/pwa-install, 100 KB) shows itself
// wherever it is mounted and can install, and mounting it costs the bundle,
// /manifest.json and the 45 KB icon. So only a load that can offer an
// install pays for it: never the installed app (the caller checks), in
// Chromium only once the browser offers installing (beforeinstallprompt:
// installable and not installed yet), and elsewhere only where the element
// has instructions to give (manualInstallPlatform). No screenshots in the
// dialog (issue #4: the household's phones already have the app).
// Mounted once per document on <html>, outside the body htmx swaps: in the
// body every navigation re-mounted it, and every mount fetched the manifest.
function offerInstall() {
  const mount = async (promptEvent) => {
    await import('pwa-install');
    const dialog = document.createElement('pwa-install');
    dialog.id = 'pwa-install';
    dialog.setAttribute('manifest-url', '/manifest.json');
    dialog.setAttribute('disable-screenshots', 'true');
    if (promptEvent) dialog.externalPromptEvent = promptEvent;
    document.documentElement.append(dialog);
    console.info(
      `[pwa] install dialog mounted (${promptEvent ? 'browser prompt' : 'instructions'})`,
    );
  };
  const failed = (error) =>
    console.warn('[pwa] install dialog failed to load', error);
  if ('BeforeInstallPromptEvent' in window) {
    window.addEventListener(
      'beforeinstallprompt',
      (event) => {
        // The element shows its own dialog in place of the browser's.
        event.preventDefault();
        mount(event).catch(failed);
      },
      { once: true },
    );
  } else if (manualInstallPlatform()) {
    mount().catch(failed);
  }
}

// Where a browser without beforeinstallprompt can still install the app, the
// platforms @khmyznikov/pwa-install gives instructions for: Add to Home
// Screen on iPhone and iPad (every browser there is WebKit), Add to Dock in
// Safari on macOS, the browser menu on Android. Anywhere else (Firefox on a
// desktop) the element would fetch everything and show nothing.
function manualInstallPlatform() {
  const ua = navigator.userAgent;
  // iPadOS asks for the desktop site by default: a "Macintosh" with touch.
  const touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  const macSafari = /Macintosh/.test(ua) && /Version\/[\d.]+ Safari\//.test(ua);
  return /iPhone|iPad|iPod|Android/.test(ua) || touchMac || macSafari;
}

// https://stackoverflow.com/questions/75972895/ios-pwa-how-to-re-enable-pull-to-refresh
// pulltorefresh binds to the page's <main> and inserts its indicator into
// the body, so a navigation (a swap of the whole body) needs it bound again;
// a fragment swap (a filter, an outfit row) leaves both in place.
async function installPullToRefresh() {
  const { default: PullToRefresh } = await import('pulltorefreshjs');
  const bind = () => {
    PullToRefresh.destroyAll();
    PullToRefresh.init({
      mainElement: 'main',
      onRefresh() {
        location.reload();
      },
    });
  };
  bind();
  document.addEventListener('htmx:afterSettle', (event) => {
    if (event.detail.target === document.body) bind();
  });
  document.addEventListener('htmx:historyRestore', bind);
}

const standalone =
  window.navigator.standalone === true ||
  window.matchMedia('(display-mode: standalone)').matches;

if ('serviceWorker' in navigator) {
  registerServiceWorker();
  watchFreshness();
}
// Also without a service worker (an http: origin): the profile page then
// says this browser cannot receive notifications.
if (document.documentElement.hasAttribute('data-signed-in')) startPush();
if (!standalone) offerInstall();
if (window.navigator.standalone === true) {
  installPullToRefresh().catch((error) =>
    console.warn('[pwa] pull to refresh failed to load', error),
  );
}
