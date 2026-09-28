import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { SENTRY_STUB_PORT, signIn } from './support/e2e-session';
import {
  type SentryEvent,
  type SentryStub,
  startSentryStub,
} from './support/sentry-stub';

/**
 * public/js/errors.js in a real browser, end to end: a page's uncaught
 * error and unhandled rejection are beaconed to POST /errors/client, which
 * forwards them to the error tracker, here Bugsink's stand-in at the DSN
 * playwright.config.ts gives the server (test/support/sentry-stub.ts).
 *
 * The beacons are counted in the browser, because the server's Sentry
 * client has its own dedupe (of an event identical to the one before it):
 * the stub alone could not tell errors.js's deduplication from Sentry's.
 *
 * Chromium only: the stub's port is fixed by the server's DSN, so one
 * browser project at a time may listen on it.
 */
test.describe('client error reports', () => {
  test.skip(
    ({ browserName, isMobile }) => browserName !== 'chromium' || isMobile,
    "the stub's port is the server's DSN: one project listens on it",
  );

  let stub: SentryStub;

  test.beforeAll(async () => {
    stub = await startSentryStub(SENTRY_STUB_PORT);
  });

  test.afterAll(async () => {
    await stub?.close();
  });

  test('sends a thrown error and an unhandled rejection once each, at most five a page view', async ({
    page,
  }) => {
    await signIn(page, 'client-errors');
    const beacons: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/errors/client') {
        const { message } = request.postDataJSON() as { message: string };
        beacons.push(message);
      }
    });
    await page.goto('/wardrobe');
    test.skip(
      (await page.locator('script[src^="/js/errors.js"]').count()) === 0,
      'needs a server started with SENTRY_DSN (playwright.config.ts sets it)',
    );

    // Each twice from one place, so the same message and stack: one report.
    const run = randomUUID().slice(0, 8);
    await page.evaluate(async (run) => {
      const thrown = () => {
        throw new Error(`e2e thrown ${run}`);
      };
      const rejected = () => Promise.reject(new Error(`e2e rejected ${run}`));
      for (let i = 0; i < 2; i++) {
        setTimeout(thrown);
        void rejected();
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }, run);
    // Five more, all distinct: the page view's allowance has three left.
    await page.evaluate(async (run) => {
      for (let i = 1; i <= 5; i++) {
        setTimeout(() => {
          throw new Error(`e2e distinct ${run} ${i}`);
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }, run);

    // A boosted navigation is another page view, with an allowance of its
    // own from the moment htmx settles it (errors.js's afterSettle). Its
    // report is sent after every report of the first page, so once it is
    // seen the first page's are all in.
    const settled = page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          document.addEventListener('htmx:afterSettle', () => resolve(), {
            once: true,
          }),
        ),
    );
    await page.locator('.dock a[href="/outfits"]').click();
    await settled;
    await expect(page).toHaveURL('/outfits');
    await page.evaluate((run) => {
      setTimeout(() => {
        throw new Error(`e2e next page ${run}`);
      });
    }, run);

    const firstPage = [
      `Error: e2e thrown ${run}`,
      `Error: e2e rejected ${run}`,
      `Error: e2e distinct ${run} 1`,
      `Error: e2e distinct ${run} 2`,
      `Error: e2e distinct ${run} 3`,
    ];
    const nextPage = `Error: e2e next page ${run}`;
    await expect.poll(() => beacons.includes(nextPage)).toBe(true);
    expect(beacons.slice(0, -1).sort()).toEqual([...firstPage].sort());
    expect(beacons.at(-1)).toBe(nextPage);

    // Each reached the tracker once, tagged with its page's route.
    const ours = (): SentryEvent[] =>
      stub.events.filter((event) =>
        event.exception?.values?.[0]?.value?.includes(run),
      );
    await expect.poll(() => ours().length, { timeout: 10_000 }).toBe(6);
    const received = ours().map((event) => ({
      message: event.exception!.values![0].value,
      type: event.exception!.values![0].type,
      source: event.tags?.source,
      route: event.tags?.route,
    }));
    expect(received).toHaveLength(6);
    expect(received).toEqual(
      expect.arrayContaining([
        ...firstPage.map((message) => ({
          message,
          type: 'ClientError',
          source: 'client',
          route: '/wardrobe',
        })),
        {
          message: nextPage,
          type: 'ClientError',
          source: 'client',
          route: '/outfits',
        },
      ]),
    );
  });
});
