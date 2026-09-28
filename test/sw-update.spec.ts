import { expect, type Page, test } from '@playwright/test';
import { signIn } from './support/e2e-session';
import { type NextBuild, startNextBuild } from './support/next-build';
import { pageErrors } from './support/page-errors';

/**
 * The installed app's update flow (src/web/shell/CLAUDE.md, Updates): a new
 * build's worker waits, public/js/pwa.js offers it in a toast, Reload posts
 * SKIP_WAITING, and the page reloads once the new worker controls it. Never
 * a forced reload, in this window or another.
 *
 * Each test runs the app behind its own proxy (test/support/next-build.ts),
 * which deploys a second build of the worker at the same URL; the browser
 * finds it with the update check it runs after navigations
 * (`registration.update()` here, so the check comes after pwa.js listens).
 *
 * Needs a server started with PWA_ENABLED=true (and VAPID keys).
 */
test.describe('service worker update', () => {
  test.skip(
    process.env.PWA_ENABLED !== 'true',
    'needs a server started with PWA_ENABLED=true',
  );
  test.skip(
    ({ browserName }) => browserName === 'firefox',
    'service workers are untested in Firefox here',
  );

  let next: NextBuild;
  test.beforeEach(async ({ page }) => {
    next = await startNextBuild();
    await signIn(page, 'sw-update');
  });
  test.afterEach(async () => {
    await next.close();
  });

  test('offers a new build without taking the page, and reloads onto it on Reload', async ({
    page,
  }) => {
    const errors = pageErrors(page, { console: true });
    await openControlled(page, () => page.goto(`${next.origin}/wardrobe`));
    // The installed app opened again: a document the worker controls from
    // its first request (the other test's first window is the first visit).
    await openControlled(page, () => page.reload());
    await markDocument(page);

    const build = next.deploy();
    await checkForUpdate(page);
    await expect(updateToast(page)).toBeVisible();
    // Installed and waiting: the page keeps its document and its worker.
    expect(await hasWaitingWorker(page)).toBe(true);
    expect(await isMarkedDocument(page)).toBe(true);

    // A boosted navigation swaps the body, toast host included: the offer
    // comes back with the new page.
    await page.locator('.dock a[href="/outfits"]').click();
    await expect(page).toHaveURL(`${next.origin}/outfits`);
    await expect(updateToast(page)).toBeVisible();
    expect(await isMarkedDocument(page)).toBe(true);

    const reloaded = page.waitForEvent('load');
    await updateToast(page).getByRole('button', { name: 'Reload' }).click();
    await reloaded;
    await expect(page.locator('.dock')).toBeVisible();
    expect(await isMarkedDocument(page)).toBe(false);
    expect(await controllingBuild(page)).toBe(build);
    expect(await hasWaitingWorker(page)).toBe(false);
    await expect(updateToast(page)).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('another window keeps its page, and its Reload loads the new build', async ({
    page,
    context,
  }) => {
    // The app's first visit: no worker controlled this document until the
    // first one claimed it.
    await openControlled(page, () => page.goto(`${next.origin}/wardrobe`));
    const other = await context.newPage();
    const otherErrors = pageErrors(other, { console: true });
    await openControlled(other, () => other.goto(`${next.origin}/outfits`));
    await markDocument(other);

    const build = next.deploy();
    await checkForUpdate(page);
    await expect(updateToast(page)).toBeVisible();
    await expect(updateToast(other)).toBeVisible();

    const reloaded = page.waitForEvent('load');
    await updateToast(page).getByRole('button', { name: 'Reload' }).click();
    await reloaded;
    expect(await controllingBuild(page)).toBe(build);
    // The new worker claims the other window too (clientsClaim) but leaves
    // its page alone, still offering the reload.
    await expect.poll(() => controllingBuild(other)).toBe(build);
    expect(await isMarkedDocument(other)).toBe(true);
    await expect(updateToast(other)).toBeVisible();

    // Nothing is waiting any more, so Reload reloads (it used to post
    // SKIP_WAITING to no worker and do nothing).
    const otherReloaded = other.waitForEvent('load');
    await updateToast(other).getByRole('button', { name: 'Reload' }).click();
    await otherReloaded;
    await expect(other.locator('.dock')).toBeVisible();
    expect(await isMarkedDocument(other)).toBe(false);
    expect(await controllingBuild(other)).toBe(build);
    await expect(updateToast(other)).toBeHidden();
    expect(otherErrors).toEqual([]);
  });
});

function updateToast(page: Page) {
  return page.locator('#toast-host [role="status"]', {
    hasText: 'Update available',
  });
}

/**
 * Loads a document of the app and waits until pwa.js has registered (it
 * listens for updates from then on, so a check before would go unseen) and
 * the service worker controls the page.
 */
async function openControlled(
  page: Page,
  load: () => Promise<unknown>,
): Promise<void> {
  const registered = page.waitForEvent('console', (message) =>
    message.text().includes('[pwa] service worker registered'),
  );
  await load();
  await registered;
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
}

/**
 * Marks the document: a boosted navigation keeps the mark (only the body is
 * swapped), a reload loses it.
 */
async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.documentElement.dataset.testDocument = 'before-update';
  });
}

function isMarkedDocument(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.dataset.testDocument === 'before-update',
  );
}

async function checkForUpdate(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) throw new Error('no service worker registration');
    await registration.update();
  });
}

function hasWaitingWorker(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return !!registration?.waiting;
  });
}

/**
 * The build whose worker controls the page (NextBuild.deploy's id), or null
 * for the server's own build, which has no answer to TEST_BUILD.
 */
function controllingBuild(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      new Promise<string | null>((resolve) => {
        const controller = navigator.serviceWorker.controller;
        if (!controller) {
          resolve(null);
          return;
        }
        const channel = new MessageChannel();
        channel.port1.onmessage = (event) => resolve(String(event.data));
        controller.postMessage({ type: 'TEST_BUILD' }, [channel.port2]);
        setTimeout(() => resolve(null), 1000);
      }),
  );
}
