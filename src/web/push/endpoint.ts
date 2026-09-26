/**
 * The push services a browser subscription may point at. The server POSTs
 * every message to the subscription's endpoint URL, which the client
 * supplies: without this list, any signed-in user could register an internal
 * address (the database, the NAS admin UI) and use the test send to make the
 * server connect to it (SSRF). Checked when a subscription is stored and
 * again before every send, so a row that predates the check is never used.
 *
 * Chrome, Edge-on-Android and Samsung Internet use FCM; Firefox uses
 * Mozilla's autopush; Safari (macOS and the installed iOS app) uses Apple's
 * web push; Edge on Windows uses WNS. A browser outside these would need an
 * entry here.
 */
export const PUSH_SERVICE_HOSTS: readonly string[] = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  '*.push.apple.com',
  '*.notify.windows.com',
];

/** https, default port, no credentials, host on the list above. */
export function isPushServiceEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  if (url.port !== '' && url.port !== '443') return false;
  const host = url.hostname.toLowerCase();
  return PUSH_SERVICE_HOSTS.some((allowed) =>
    allowed.startsWith('*.')
      ? host.endsWith(allowed.slice(1)) && host.length > allowed.length - 1
      : host === allowed,
  );
}
