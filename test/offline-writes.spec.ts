import { expect, type Page, test } from '@playwright/test';
import { signIn } from './support/e2e-session';
import { pageErrors } from './support/page-errors';

/**
 * Every PostForm is disabled offline (#411; owner, 2026-10-22): when
 * connectivity.js's heartbeat fails, every control that can submit a
 * `data-needs-network` form is `disabled`, those outside it through `form=`
 * included (the add sheet's photo inputs), and coming back online re-enables
 * exactly those. Its log line counts them. The forms are found on the page,
 * not listed; the integration tier's expectFullPage holds every page's
 * PostForms to the marker.
 */

// The worker blocked: once it controls the page, WebKit sends the heartbeat
// through it and page.route never sees it (docs/testing-webkit.md, #436).
// connectivity.js runs the same with or without one, so nothing is lost.
test.use({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });

/** Each guarded form's controls: how many, and how many are disabled. */
function guardedControls(page: Page) {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLFormElement>('form[data-needs-network]'),
      (form) => {
        const controls = Array.from(form.elements).filter(
          (el): el is HTMLButtonElement | HTMLInputElement =>
            el.matches('button, input, select, textarea'),
        );
        return {
          action: form.getAttribute('action'),
          controls: controls.length,
          disabled: controls.filter((el) => el.disabled).length,
          outside: controls.filter((el) => !form.contains(el)).length,
          // connectivity.js's mark on the controls it disabled.
          marked: controls.filter((el) => 'offlineDisabled' in el.dataset)
            .length,
        };
      },
    ),
  );
}

/** Fails the heartbeat (or lets it through) and tells the page to probe. */
async function setReachable(page: Page, reachable: boolean) {
  if (reachable) await page.unroute('**/health/live');
  else await page.route('**/health/live', (route) => route.abort());
  await page.evaluate(
    (event) => window.dispatchEvent(new Event(event)),
    reachable ? 'online' : 'offline',
  );
  await expect(page.locator('#connectivity-banner')).toBeVisible({
    visible: !reachable,
  });
}

test('every PostForm on a page is disabled offline and restored online', async ({
  page,
}) => {
  const errors = pageErrors(page);
  await signIn(page, 'offline-writes');
  let outside = 0;
  for (const url of ['/wardrobe', '/auth/profile', '/auth/tokens']) {
    await page.goto(url);
    const online = await guardedControls(page);
    expect(online.length, url).toBeGreaterThan(0);

    const logged = page.waitForEvent('console', (message) =>
      message.text().includes('write controls disabled'),
    );
    await setReachable(page, false);
    const offline = await guardedControls(page);
    for (const form of offline) {
      expect(form, url).toMatchObject({ disabled: form.controls });
    }
    const forms = offline.filter((form) => form.marked > 0).length;
    expect(forms, url).toBeGreaterThan(0);
    expect((await logged).text()).toContain(`(${forms} forms)`);
    outside += offline.reduce((sum, form) => sum + form.outside, 0);

    await setReachable(page, true);
    await expect.poll(() => guardedControls(page)).toEqual(online);
  }
  // The add sheet's camera and library inputs name their forms in `form=`.
  expect(outside).toBeGreaterThanOrEqual(2);
  expect(errors).toEqual([]);
});
