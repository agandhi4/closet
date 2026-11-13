import { expect, type Page, test } from '@playwright/test';
import { createGarment, createOutfit } from './support/e2e-data';
import {
  E2E_PASSWORD,
  SAME_ORIGIN,
  signIn,
  signUpHeaders,
} from './support/e2e-session';
import { householdToday } from './support/household-today';
import { pageErrors } from './support/page-errors';
import { addDays } from '../src/calendar-date';
import { queueableKindOf } from '../src/offline-writes';

/**
 * Every PostForm is disabled offline (#411; owner, 2026-10-22): when
 * connectivity.js's heartbeat fails, every control that can submit a
 * `data-needs-network` form is `disabled`, those outside it through `form=`
 * included (the add sheet's photo inputs), and coming back online re-enables
 * exactly those. Its log line counts them. The forms are found on the page,
 * not listed; the integration tier's expectFullPage holds every page's
 * PostForms to the marker.
 *
 * Except the writes the outbox queues (#178, public/js/outbox.js): Wore
 * today and a packing tick stay enabled offline, show their other state and
 * "Waiting to sync", and save on reconnect; a write the server refuses is a
 * notice until dismissed or signed out; another account's page never sends
 * them. Their markup is test/integration/queued-writes.spec.ts's.
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

/**
 * Offline for writes too: every POST the page sends fails like the
 * heartbeat, so a queued write can only wait. Pages still load (GET), as a
 * cached copy would.
 */
async function setWritesReachable(page: Page, reachable: boolean) {
  if (reachable) {
    await page.unroute('**/*');
  } else {
    await page.route('**/*', (route) =>
      route.request().method() === 'POST' ? route.abort() : route.fallback(),
    );
  }
  await setReachable(page, reachable);
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

test('wears and ticks queue offline, save on reconnect, and stay their account’s', async ({
  page,
}) => {
  const errors = pageErrors(page);
  const email = await signIn(page, 'outbox');
  const chinos = await createGarment(page, 'Navy chinos');
  const gone = await createGarment(page, 'Gone tee');
  const today = householdToday();
  const created = await page.request.post('/trips', {
    form: {
      name: 'Queued trip',
      destination: '',
      startsOn: today,
      endsOn: addDays(today, 1),
      notes: '',
    },
    headers: SAME_ORIGIN,
  });
  const tripUrl = new URL(created.url()).pathname;
  expect(
    (
      await page.request.post(`${tripUrl}/outfits`, {
        form: {
          outfitId: String(await createOutfit(page, 'Trip look', chinos)),
          day: '',
          occasion: '',
        },
        headers: SAME_ORIGIN,
      })
    ).ok(),
  ).toBe(true);
  // Queued writes that reached the server, and every one attempted.
  const saved: string[] = [];
  const attempted: string[] = [];
  const queued = (url: string) => queueableKindOf(new URL(url).pathname);
  page.on('requestfinished', (request) => {
    if (queued(request.url())) saved.push(request.url());
  });
  page.on('request', (request) => {
    if (queued(request.url())) attempted.push(request.url());
  });
  const offlineBanner = page.locator('#connectivity-banner');
  const banner = page.locator('#outbox-banner');
  const pendingChips = page.locator(
    '[data-outbox="pending"] [data-outbox-chip]',
  );
  const wore = page.getByRole('button', { name: 'Wore today', exact: true });
  const undo = page.getByRole('button', { name: 'Undo “Wore today”' });

  // Offline: the tap shows its other state and waits, nothing sent.
  await page.goto(`/wardrobe/${chinos}`);
  await setWritesReachable(page, false);
  await expect(wore).toBeEnabled();
  await wore.click();
  await expect(undo).toBeVisible();
  await expect(pendingChips).toHaveCount(1);
  await expect(banner).toHaveText('1 change waiting to sync');
  await page.goto(`/wardrobe/${gone}`);
  await expect(offlineBanner).toBeVisible();
  await wore.click();
  await expect(banner).toHaveText('2 changes waiting to sync');
  await page.goto(tripUrl);
  await expect(offlineBanner).toBeVisible();
  await page.getByRole('checkbox', { name: /Navy chinos/ }).check();
  await expect(pendingChips).toHaveCount(1);
  await expect(banner).toHaveText('3 changes waiting to sync');
  expect(saved).toEqual([]);

  // Reopened offline, the page shows what waits, from the records.
  await page.goto(`/wardrobe/${chinos}`);
  await expect(undo).toBeVisible();
  await expect(pendingChips).toHaveCount(1);

  // The tee goes meanwhile (elsewhere): its wear cannot be saved.
  expect(
    (
      await page.request.delete(`/wardrobe/${gone}`, { headers: SAME_ORIGIN })
    ).ok(),
  ).toBe(true);

  // Back online: saved, said once, and the refusal stays.
  await setWritesReachable(page, true);
  await expect(page.getByText('2 changes saved')).toBeVisible();
  await expect(pendingChips).toHaveCount(0);
  await expect(banner).toBeHidden();
  const notice = page.locator('#outbox-notice');
  await expect(notice).toContainText(
    'Gone tee, Wore today: not saved, it was deleted.',
  );
  await page.reload();
  await expect(undo).toBeVisible();
  await expect(notice).toBeVisible();
  await page.goto(tripUrl);
  await expect(
    page.getByRole('checkbox', { name: /Navy chinos/ }),
  ).toBeChecked();

  // Signing out with the refusal unsynced asks before discarding it.
  await page.locator('#avatar').click();
  page.once('dialog', (dialog) => {
    expect(dialog.message()).toBe(
      '1 change has not synced. Sign out and discard it?',
    );
    void dialog.accept();
  });
  await page
    .locator('#sign-out')
    .getByRole('button', { name: 'Logout' })
    .click();
  await expect(page).toHaveURL(/\/auth\/login$/);

  // Queued as one account, the page of another deletes it unsent.
  expect(
    (
      await page.request.post('/auth/login', {
        form: { email, password: E2E_PASSWORD },
        headers: signUpHeaders(),
      })
    ).ok(),
  ).toBe(true);
  await page.goto(`/wardrobe/${chinos}`);
  await setWritesReachable(page, false);
  await undo.click();
  await expect(banner).toHaveText('1 change waiting to sync');
  // Signed out (a revoked session) and in as someone else before it could
  // sync: still offline, so only the new page's own rule can act on it.
  await page.context().clearCookies();
  await signIn(page, 'outbox-other');
  attempted.length = 0;
  const deleted = page.waitForEvent('console', (message) =>
    message.text().includes('of another account deleted unsent'),
  );
  await page.goto('/wardrobe');
  expect((await deleted).text()).toContain('[outbox] 1 queued change(s)');
  await setWritesReachable(page, true);
  await expect(banner).toBeHidden();
  expect(attempted).toEqual([]);
  expect(errors).toEqual([]);
});
