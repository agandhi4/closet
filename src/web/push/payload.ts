/**
 * The one message Web Push carries: written by the sender
 * (src/web/push/sender.ts) and read by the service worker's push handler
 * (views/assets/src-sw.ts), which bundles this file, so the two cannot drift
 * apart again (they had: the worker read `options.body` while the server
 * sent `body`). Framework-free on purpose: it runs in the worker.
 */
export interface PushPayload {
  title: string;
  body: string;
  /** Path the notification opens on click, e.g. '/calendar'. Same origin only. */
  url: string;
  /** A later notification with the same tag replaces this one instead of stacking. */
  tag?: string;
}

/** The payload in a push message's parsed JSON, or undefined when it is not one. */
export function parsePushPayload(data: unknown): PushPayload | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const { title, body, url, tag } = data as Record<string, unknown>;
  if (
    typeof title !== 'string' ||
    typeof body !== 'string' ||
    typeof url !== 'string' ||
    (tag !== undefined && typeof tag !== 'string')
  ) {
    return undefined;
  }
  return tag === undefined ? { title, body, url } : { title, body, url, tag };
}

/**
 * The absolute URL a notification click opens: the payload's url resolved
 * against the app's origin, or the app's root when it would leave the
 * origin (a notification is never a way off the site).
 */
export function notificationTarget(url: string, origin: string): string {
  const home = new URL('/', origin).href;
  let target: URL;
  try {
    target = new URL(url, origin);
  } catch {
    // Unparsable ("http://[") is treated like a foreign URL.
    return home;
  }
  return target.origin === new URL(origin).origin ? target.href : home;
}
