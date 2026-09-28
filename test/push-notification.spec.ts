import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import type { PushPayload } from '../src/web/push/payload';
import { signIn } from './support/e2e-session';
import { pageErrors } from './support/page-errors';
import { workerLogs } from './support/service-worker';
import { WEBKIT_HAS_NO_PUSH } from './support/webkit-limits';

/**
 * A push message reaching the service worker (`push` in
 * views/assets/src-sw.ts): the message the server's sender writes
 * (PushPayload) shows its notification, carrying the page a tap opens;
 * anything else shows nothing.
 *
 * DevTools delivers the push (CDP `ServiceWorker.deliverPushMessage`): a
 * real push event with the payload as the browser hands it over once
 * decrypted. The push service and web-push's encryption stay out of reach
 * (push-settings.spec.ts says why). No automation can tap a system
 * notification either, so what the tap opens is
 * src/web/push/notification-click.spec.ts, over the data asserted here.
 *
 * Needs a server started with PWA_ENABLED=true (and VAPID keys).
 */

// The full Chromium build: the default headless shell denies notifications
// whatever the context granted (src/push/CLAUDE.md, Gotchas), and
// showNotification() then rejects. Top level because a channel needs its
// own worker; other browsers skip below before launching anything.
test.use({ channel: 'chromium' });

test.describe('push notifications', () => {
  test.skip(
    process.env.PWA_ENABLED !== 'true',
    'needs a server started with PWA_ENABLED=true',
  );
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    `pushes are delivered through Chromium's DevTools protocol; ${WEBKIT_HAS_NO_PUSH}`,
  );

  test.beforeEach(async ({ page, context }) => {
    await context.grantPermissions(['notifications']);
    await signIn(page, 'push-notification');
    await page.goto('/wardrobe');
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  });

  test('shows the reminder a push carries, with the page a tap opens', async ({
    page,
    context,
  }) => {
    const errors = pageErrors(page, { console: true });
    const push = await pushTo(page, context);

    await push(
      JSON.stringify({
        title: "Today's outfit",
        body: '18°, light rain\nWork: Navy suit',
        url: '/',
        tag: 'today-morning',
      } satisfies PushPayload),
    );
    await expect
      .poll(() => shownNotifications(page))
      .toEqual([
        {
          title: "Today's outfit",
          body: '18°, light rain\nWork: Navy suit',
          tag: 'today-morning',
          data: { url: '/' },
        },
      ]);

    // A later message with the same tag replaces the unread one rather
    // than stacking (the re-planned morning, the next day's reminder).
    await push(
      JSON.stringify({
        title: "Today's outfit",
        body: 'Work: Wool coat',
        url: '/calendar',
        tag: 'today-morning',
      } satisfies PushPayload),
    );
    await expect
      .poll(() => shownNotifications(page))
      .toEqual([
        {
          title: "Today's outfit",
          body: 'Work: Wool coat',
          tag: 'today-morning',
          data: { url: '/calendar' },
        },
      ]);
    expect(errors).toEqual([]);
  });

  test('shows nothing for a push that is not the app’s message', async ({
    page,
    context,
  }) => {
    const push = await pushTo(page, context);

    for (const data of [
      'not json',
      JSON.stringify({ title: 'Today', body: 'Navy suit' }),
      JSON.stringify({ title: 1, body: 'Navy suit', url: '/' }),
    ]) {
      const ignored = workerLogs(
        context,
        'push message without a readable payload, ignored',
      );
      await push(data);
      await ignored;
    }
    expect(await shownNotifications(page)).toEqual([]);
  });
});

/**
 * Delivers push messages to the page's service worker registration
 * through the DevTools protocol, which dispatches a push event with `data`.
 */
async function pushTo(page: Page, context: BrowserContext) {
  const origin = new URL(page.url()).origin;
  const cdp = await context.newCDPSession(page);
  const registrationId = new Promise<string>((resolve) => {
    cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
      const registration = registrations.find(
        ({ scopeURL, isDeleted }) => !isDeleted && scopeURL === `${origin}/`,
      );
      if (registration) resolve(registration.registrationId);
    });
  });
  await cdp.send('ServiceWorker.enable');
  const id = await registrationId;
  return async (data: string) => {
    await cdp.send('ServiceWorker.deliverPushMessage', {
      origin,
      registrationId: id,
      data,
    });
  };
}

/** The notifications the service worker is showing. */
function shownNotifications(page: Page) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const shown = await registration.getNotifications();
    return shown.map(({ title, body, tag, data }) => ({
      title,
      body,
      tag,
      data: data as unknown,
    }));
  });
}
