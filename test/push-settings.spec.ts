import { expect, type Page, test } from '@playwright/test';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { signIn } from './support/e2e-session';

/**
 * The profile page's notification controls (<push-settings>, public/js/
 * push.js) in a real browser: the state it shows for this device, and
 * enabling, disabling and the test send through the real routes.
 *
 * Headless Chromium has no push service to subscribe with, so where a
 * subscription is needed the page's PushManager is replaced by a stand-in
 * holding a subscription with real key sizes; everything after it (the
 * server's upsert, the sender, web-push's encryption) is real. The test
 * send's endpoint is a closed local port, so delivery fails fast and the
 * answer says so. A real delivery is out of scope.
 *
 * Needs a server started with PWA_ENABLED=true (and VAPID keys), as
 * test/pwa.spec.ts does; Chromium only.
 */

interface FakeSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

function fakeSubscription(): FakeSubscription {
  return {
    // Nothing listens on port 1: the server's send fails at connect.
    endpoint: `https://127.0.0.1:1/push/${randomUUID()}`,
    keys: {
      p256dh: createECDH('prime256v1').generateKeys().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };
}

/** Replaces PushManager with a stand-in, before any page script runs. */
async function stubPushManager(
  page: Page,
  subscription: FakeSubscription,
  subscribed: boolean,
) {
  await page.addInitScript(
    ({ subscription, subscribed }) => {
      const make = () => ({
        endpoint: subscription.endpoint,
        toJSON: () => subscription,
        unsubscribe: () => {
          current = null;
          return Promise.resolve(true);
        },
      });
      let current: ReturnType<typeof make> | null = subscribed ? make() : null;
      PushManager.prototype.getSubscription = function () {
        return Promise.resolve(current as unknown as PushSubscription | null);
      };
      PushManager.prototype.subscribe = function () {
        current = make();
        return Promise.resolve(current as unknown as PushSubscription);
      };
    },
    { subscription, subscribed },
  );
}

// The full Chromium build in its new headless mode, not the default headless
// shell: the shell answers Notification.permission 'denied' whatever
// grantPermissions() set (the Permissions API says 'granted'), which no real
// browser does. `playwright install chromium` installs both. Top level
// because a channel needs its own worker; other browsers skip below before
// launching anything.
test.use({ channel: 'chromium' });

test.describe('notification settings on the profile page', () => {
  test.skip(
    process.env.PWA_ENABLED !== 'true',
    'needs a server started with PWA_ENABLED=true',
  );
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'service workers and push are only reliable in chromium here',
  );

  test.beforeEach(async ({ page }) => {
    await signIn(page, 'push-settings');
  });

  const settings = (page: Page) => page.locator('push-settings');
  const shown = (page: Page, state: string) =>
    settings(page).locator(`p[data-show="${state}"]`);

  test('offers to enable notifications when this device has none', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['notifications']);
    await page.goto('/auth/profile');

    await expect(shown(page, 'off')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Enable notifications on this device' }),
    ).toBeVisible();
    await expect(shown(page, 'checking')).toBeHidden();
    await expect(
      page.getByRole('button', { name: 'Turn off on this device' }),
    ).toBeHidden();
  });

  test('enables on a tap, sends a test, and turns off', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['notifications']);
    await stubPushManager(page, fakeSubscription(), false);
    await page.goto('/auth/profile');

    await page
      .getByRole('button', { name: 'Enable notifications on this device' })
      .click();
    await expect(shown(page, 'on')).toBeVisible();

    // The server stored the device and tried it: the local endpoint refuses.
    await page
      .getByRole('button', { name: 'Send a test notification' })
      .click();
    await expect(page.locator('#push-test-result')).toContainText(
      'The test could not be delivered to 1 of your devices.',
    );

    await page.getByRole('button', { name: 'Turn off on this device' }).click();
    await expect(shown(page, 'off')).toBeVisible();

    await page
      .getByRole('button', { name: 'Send a test notification' })
      .click();
    await expect(page.locator('#push-test-result')).toContainText(
      'No device has notifications on.',
    );
  });

  test('shows an existing subscription as on after confirming it with the server', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['notifications']);
    await stubPushManager(page, fakeSubscription(), true);
    const confirmed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/push/subscribe' &&
        response.request().method() === 'POST',
    );
    await page.goto('/auth/profile');

    expect((await confirmed).status()).toBe(204);
    await expect(shown(page, 'on')).toBeVisible();
  });

  test('says notifications are blocked when permission was denied', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Notification, 'permission', {
        get: () => 'denied',
      });
    });
    await page.goto('/auth/profile');

    await expect(shown(page, 'blocked')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Enable notifications on this device' }),
    ).toBeHidden();
  });

  test('sends iOS Safari users to the installed app', async ({ page }) => {
    // What a Safari tab on iPhone looks like to the page: no PushManager, and
    // navigator.standalone false (it only exists on iOS).
    await page.addInitScript(() => {
      Reflect.deleteProperty(window, 'PushManager');
      Object.defineProperty(navigator, 'standalone', { get: () => false });
    });
    await page.goto('/auth/profile');

    await expect(shown(page, 'install')).toBeVisible();
  });
});
