import { expect, test } from '@playwright/test';
import { SAME_ORIGIN, signIn } from './support/e2e-session';
import { pageErrors } from './support/page-errors';

/**
 * connectivity.js (public/js/connectivity.js) must never mistake a request
 * the page itself cancelled for evidence the server is unreachable. #241:
 * in WebKit, a native form post cancels any htmx request in flight, which
 * used to raise htmx:sendError and flash the offline banner for up to 5 s.
 * setState logs every transition (`[connectivity] x -> y`), so that line
 * proves the flip happened even when it is too quick for the banner's
 * `hidden` class to be worth polling for.
 *
 * Chromium never cancels the in-flight request this way, so this spec is
 * green there before and after the fix; the regression only shows up (and
 * was verified red on the pre-fix code) in the nightly WebKit projects.
 */
test('a native form post during an in-flight htmx request never marks the app offline', async ({
  page,
}) => {
  const errors = pageErrors(page);
  const connectivityDrops: string[] = [];
  page.on('console', (message) => {
    if (/\[connectivity] \w+ -> (offline|reconnecting)/.test(message.text())) {
      connectivityDrops.push(message.text());
    }
  });

  await signIn(page, 'connectivity-unload');
  const created = await page.request.post('/wardrobe', {
    form: { name: 'Unload tee', category: 'tops' },
    headers: SAME_ORIGIN,
    maxRedirects: 0,
  });
  expect(created.status()).toBe(302);
  const garmentId = /^\/wardrobe\/(\d+)\?/.exec(
    created.headers().location ?? '',
  )?.[1];
  await page.goto(`/wardrobe/${garmentId}`);

  const wore = page.getByRole('button', { name: 'Wore today' });
  await expect(wore).toBeVisible();

  // Held forever: the navigation below cancels this request out from under
  // the route handler, which is what raises htmx:sendError in WebKit.
  await page.route(
    `**/wardrobe/${garmentId}/wear`,
    () => new Promise<void>(() => {}),
  );
  await wore.click();

  // A native form post, not htmx: a whole-document navigation, exactly what
  // cancels the request above.
  await page.evaluate(() => {
    const form = document.createElement('form');
    form.method = 'post';
    form.action = '/auth/logout';
    document.body.append(form);
    form.submit();
  });
  await page.waitForURL(/\/auth\/login/);

  expect(connectivityDrops).toEqual([]);
  expect(errors).toEqual([]);
});
