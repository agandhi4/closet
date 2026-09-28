import { expect, type Page, test } from '@playwright/test';
import {
  changePasswordElsewhere,
  E2E_NEW_PASSWORD,
  E2E_PASSWORD,
  signIn,
} from './support/e2e-session';
import { fakeSubscription, stubPushManager } from './support/push-stub';
import { waitForServiceWorker } from './support/service-worker';
import { WEBKIT_HAS_NO_PUSH } from './support/webkit-limits';

/**
 * A password change keeps the notifications of the device that made it and
 * revokes every other device's (#73). Here the browser's part: the change
 * form names this device (<push-endpoint>, public/js/push.js), and a device
 * whose session ended elsewhere drops its browser subscription on the login
 * page it is sent to (<push-signed-out>), whether a document load or a
 * boosted tap lands there. The rows, the CLIs and the scheduler are
 * test/integration/push-revocation.spec.ts.
 *
 * Headless Chromium has no push service, so the page's PushManager is the
 * stand-in (test/support/push-stub.ts), which each document starts
 * subscribed: a drop is seen in the document that made it. Needs a server
 * started with PWA_ENABLED=true (the worker registration push.js reads).
 */
test.describe('push subscriptions and revoked sessions', () => {
  test.skip(
    process.env.PWA_ENABLED !== 'true',
    'needs a server started with PWA_ENABLED=true',
  );
  test.skip(({ browserName }) => browserName === 'webkit', WEBKIT_HAS_NO_PUSH);
  test.skip(
    ({ browserName }) => browserName === 'firefox',
    'service workers are untested in Firefox here',
  );

  /** This browser's subscription endpoint, or null without one. */
  const browserSubscription = (page: Page) =>
    page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      return subscription?.endpoint ?? null;
    });

  /** Signed in, notifications on, confirmed with the server. */
  async function subscribedDevice(page: Page, prefix: string) {
    const subscription = fakeSubscription();
    // granted: the headless shell reports 'denied' whatever the context
    // grants (CLAUDE.md, Gotchas).
    await stubPushManager(page, subscription, true, { granted: true });
    const email = await signIn(page, prefix);
    await waitForServiceWorker(page);
    const confirmed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/push/subscribe' &&
        response.request().method() === 'POST',
    );
    await page.goto('/auth/profile');
    expect((await confirmed).status()).toBe(204);
    await expect(page.locator('push-settings p[data-show="on"]')).toBeVisible();
    return { email, subscription };
  }

  test('the device that changes the password keeps its notifications and reminders', async ({
    page,
  }) => {
    const { subscription } = await subscribedDevice(page, 'push-changer');
    const reminders = page.locator('#push-reminders');
    const saved = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/push/reminders' &&
        response.request().method() === 'POST',
    );
    await reminders
      .getByRole('checkbox', { name: "Morning: today's outfit" })
      .check();
    expect((await saved).status()).toBe(200);

    await page.goto('/auth/change-password');
    // push.js names this device in the form before it is sent.
    await expect(page.locator('input[name="pushEndpoint"]')).toHaveValue(
      subscription.endpoint,
    );
    await page.getByLabel('Current Password').fill(E2E_PASSWORD);
    await page
      .getByLabel('New Password', { exact: true })
      .fill(E2E_NEW_PASSWORD);
    await page.getByLabel('Confirm Password').fill(E2E_NEW_PASSWORD);
    await page.getByRole('button', { name: 'Change Password' }).click();
    await expect(page).toHaveURL(/\/auth\/profile\?passwordChanged=1$/);

    // The row was kept, not re-created by the next page's sync: its
    // reminder is still on.
    await expect(
      page
        .locator('#push-reminders')
        .getByRole('checkbox', { name: "Morning: today's outfit" }),
    ).toBeChecked();
  });

  test('a device signed out by a password change elsewhere drops its subscription on the login page', async ({
    page,
    browser,
  }) => {
    const { email } = await subscribedDevice(page, 'push-revoked');
    const other = await changePasswordElsewhere(browser, email);

    // The app opened again: the session gate sends it to log in.
    await page.goto('/wardrobe');
    await expect(page).toHaveURL(/\/auth\/login$/);
    await expect.poll(() => browserSubscription(page)).toBeNull();
    await other.close();
  });

  test('a boosted tap that lands on the login page drops it too', async ({
    page,
    browser,
  }) => {
    const { email, subscription } = await subscribedDevice(
      page,
      'push-revoked-tap',
    );
    await page.goto('/calendar');
    expect(await browserSubscription(page)).toBe(subscription.endpoint);
    const other = await changePasswordElsewhere(browser, email);

    // htmx follows the redirect and swaps the login page's body in.
    await page.locator('.dock a[href="/outfits"]').click();
    await expect(page.locator('form[action="/auth/login"]')).toBeVisible();
    await expect.poll(() => browserSubscription(page)).toBeNull();
    await other.close();
  });

  test('a signed-in visit to the login page keeps the subscription', async ({
    page,
  }) => {
    const { subscription } = await subscribedDevice(page, 'push-kept');
    await page.goto('/auth/login');
    await expect(page.locator('push-signed-out')).toHaveCount(0);
    // Give push.js the time it would take to act, then look.
    await page.waitForLoadState('networkidle');
    expect(await browserSubscription(page)).toBe(subscription.endpoint);
  });
});
