import { expect, type Page, test } from '@playwright/test';
import { signIn } from './support/e2e-session';
import { fakeSubscription, stubPushManager } from './support/push-stub';

/**
 * The profile page's notification controls (<push-settings>, public/js/
 * push.js) in a real browser: the state it shows for this device, and
 * enabling, disabling and the test send through the real routes.
 *
 * Playwright's contexts are incognito, where Chromium refuses every push
 * subscription (AbortError, "Registration failed - permission denied",
 * crbug.com/41124656) whatever the permission says. A persistent context
 * does subscribe, but through Google's push service on the internet, which
 * no spec may depend on. So the real PushManager is exercised as far as it
 * goes (its empty getSubscription, its refused subscribe); where a
 * subscription is needed the page's PushManager is replaced by a stand-in
 * (test/support/push-stub.ts), and everything after it (the server's
 * upsert, the reminders, the sender, web-push's encryption) is real. The test
 * send's endpoint is an unresolvable name under push.apple.com (subscribe
 * only accepts push-service hosts), so delivery fails at DNS and the answer
 * says so. A real delivery is out of scope.
 *
 * Needs a server started with PWA_ENABLED=true (and VAPID keys), as
 * test/pwa.spec.ts does; Chromium only.
 */

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

  test("shows an error, not on, when the browser's push service refuses to subscribe", async ({
    page,
    context,
  }) => {
    // The real PushManager: permission granted, the subscription refused.
    await context.grantPermissions(['notifications']);
    const subscribes: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/push/subscribe') {
        subscribes.push(request.method());
      }
    });
    await page.goto('/auth/profile');
    await expect(shown(page, 'off')).toBeVisible();

    const enable = page.getByRole('button', {
      name: 'Enable notifications on this device',
    });
    await enable.click();

    await expect(shown(page, 'error')).toBeVisible();
    await expect(shown(page, 'on')).toBeHidden();
    // Nothing reached the server, and the tap can be tried again.
    expect(subscribes).toEqual([]);
    await expect(enable).toBeEnabled();
    expect(
      await page.evaluate(async () =>
        (await navigator.serviceWorker.ready).pushManager.getSubscription(),
      ),
    ).toBeNull();

    // A new visit finds no subscription: off, not a stale "on".
    await page.reload();
    await expect(shown(page, 'off')).toBeVisible();
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

  test("once on, sets this device's reminders, saved on every change (#15)", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['notifications']);
    // Subscribed already: the stand-in's state lives in the document, so a
    // subscription made by a tap would be gone after the reload below.
    await stubPushManager(page, fakeSubscription(), true);
    await page.goto('/auth/profile');
    await expect(shown(page, 'on')).toBeVisible();

    const reminders = page.locator('#push-reminders');
    await expect(reminders).toBeVisible();
    const morning = reminders.getByRole('checkbox', {
      name: "Morning: today's outfit",
    });
    await expect(morning).not.toBeChecked();
    const save = () =>
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/push/reminders' &&
          response.request().method() === 'POST',
      );
    let saved = save();
    await morning.check();
    expect((await saved).status()).toBe(200);
    await expect(reminders.getByText('Saved.')).toBeVisible();
    saved = save();
    await reminders
      .getByLabel('Evening: what did you wear?: Time')
      .selectOption('22:00');
    await saved;
    saved = save();
    await reminders
      .getByRole('checkbox', { name: 'Evening: what did you wear?' })
      .check();
    await saved;

    // A reload asks the server again: the device's reminders are kept.
    await page.reload();
    const again = page.locator('#push-reminders');
    await expect(
      again.getByRole('checkbox', { name: "Morning: today's outfit" }),
    ).toBeChecked();
    await expect(
      again.getByRole('checkbox', { name: 'Evening: what did you wear?' }),
    ).toBeChecked();
    await expect(again.locator('select[name="evening"]')).toHaveValue(
      String(22 * 60),
    );

    // Turned off, the reminders go with the device.
    await page.getByRole('button', { name: 'Turn off on this device' }).click();
    await expect(page.locator('#push-reminders')).toBeHidden();
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
