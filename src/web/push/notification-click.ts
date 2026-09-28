import { notificationTarget } from './payload';

/**
 * What a tap on a notification opens, for the service worker's
 * `notificationclick` (views/assets/src-sw.ts, which bundles this file).
 * Framework-free and written against the few Clients members it uses, so
 * notification-click.spec.ts can drive every branch: no browser automation
 * clicks a system notification (test/push-notification.spec.ts shows one).
 */

/** The WindowClient members used here. */
export interface AppWindow {
  readonly url: string;
  focus(): Promise<AppWindow>;
  navigate(url: string): Promise<AppWindow | null>;
}

/** The Clients members used here (`self.clients` in the worker). */
export interface AppWindows {
  matchAll(options: { type: 'window' }): Promise<readonly AppWindow[]>;
  openWindow(url: string): Promise<unknown>;
}

/**
 * Opens the page a notification names (its `data.url`, written by the push
 * handler from PushPayload.url; the app's root when absent or off-origin,
 * notificationTarget): in a window already showing it, else in the first
 * open window of the app, else in a new one.
 */
export async function openNotification(
  windows: AppWindows,
  data: unknown,
  origin: string,
): Promise<void> {
  const url = notificationTarget(notificationUrl(data), origin);
  // Controlled windows only (clientsClaim makes that every open page):
  // navigate() is refused for the others.
  const open = await windows.matchAll({ type: 'window' });
  const showing = open.find((window) => window.url === url);
  if (showing) {
    await showing.focus();
    return;
  }
  const [first] = open;
  if (first) {
    const focused = await first.focus();
    // Null when the browser declines to navigate it (older WebKit): open a
    // window instead.
    if (await focused.navigate(url)) return;
  }
  await windows.openWindow(url);
}

function notificationUrl(data: unknown): string {
  return typeof data === 'object' && data !== null && 'url' in data
    ? String(data.url)
    : '/';
}
