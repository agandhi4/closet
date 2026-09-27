import type { Page } from '@playwright/test';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';

/**
 * A browser push subscription for Playwright, which has no push service:
 * test/push-settings.spec.ts and the screenshots' notification settings.
 * The page's PushManager is replaced by a stand-in holding a subscription
 * with real key sizes; everything after it (the server's upsert, the
 * reminders, the sender, web-push's encryption) is real.
 */

export interface FakeSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export function fakeSubscription(): FakeSubscription {
  return {
    // Allowed by the push-service list (*.push.apple.com) but a name that does
    // not resolve: the server's send fails at DNS, so nothing reaches Apple.
    endpoint: `https://closet-e2e-${randomUUID().slice(0, 8)}.invalid-test.push.apple.com/push/${randomUUID()}`,
    keys: {
      p256dh: createECDH('prime256v1').generateKeys().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };
}

/**
 * Replaces PushManager with a stand-in, before any page script runs.
 * `granted`: also answer Notification.permission 'granted', for the default
 * headless shell, which reports 'denied' whatever the context granted
 * (CLAUDE.md, Gotchas).
 */
export async function stubPushManager(
  page: Page,
  subscription: FakeSubscription,
  subscribed: boolean,
  options: { granted?: boolean } = {},
): Promise<void> {
  await page.addInitScript(
    ({ subscription, subscribed, granted }) => {
      if (granted) {
        Object.defineProperty(Notification, 'permission', {
          get: () => 'granted',
        });
      }
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
    { subscription, subscribed, granted: options.granted ?? false },
  );
}
