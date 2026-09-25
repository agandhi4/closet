/**
 * Installed-app plumbing, loaded from layout.hbs when PWA_ENABLED: service
 * worker registration and the update flow, web push subscription, and pull
 * to refresh for iOS standalone (which has none of its own). Lives in the
 * head so hx-boost body swaps never re-run it; anything that touches the
 * body re-applies itself on htmx:afterSettle.
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
import PullToRefresh from 'pulltorefreshjs';
import { showToast } from 'toast';

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

  wb.register().then(() => {
    console.info('[pwa] service worker registered');
    const authenticated = document.cookie
      .split('; ')
      .some((row) => row.startsWith('access_token='));
    if (!authenticated) return;
    import('web-push').then((module) =>
      module.default
        .subscribe()
        .catch((err) => console.warn('[pwa] web push subscription failed', err)),
    );
  });
}

// https://stackoverflow.com/questions/75972895/ios-pwa-how-to-re-enable-pull-to-refresh
// pulltorefresh binds to the <main> element at init, so it has to be redone
// after each body swap.
function installPullToRefresh() {
  const init = () => {
    PullToRefresh.destroyAll();
    PullToRefresh.init({
      mainElement: 'main',
      onRefresh() {
        location.reload();
      },
    });
  };
  init();
  document.addEventListener('htmx:afterSettle', init);
}

if ('serviceWorker' in navigator) registerServiceWorker();
if (window.navigator.standalone === true) installPullToRefresh();
