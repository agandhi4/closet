import { expect, type Page, type Route, test } from '@playwright/test';
import { REPLAY_TIMEOUT_MS } from '../src/offline-writes';
import { t as text } from '../src/web/i18n';
import { SAME_ORIGIN, signIn } from './support/e2e-session';
import { householdToday } from './support/household-today';
import { pageErrors } from './support/page-errors';

/**
 * Wears and washes in a browser at phone width (#7): the calendar's worn
 * pill swapping in place and logging the outfit's wears, the garment page's
 * Washed, Wore today and "Where it is" answering through htmx, multiples,
 * the laundry page's Mark washed, and a failed tap saying so (#642: a 503
 * toast, a timeout, a deleted garment's tile). The server side is
 * test/integration/wears.spec.ts; the offline write rule is the pwa spec's.
 */

test.use({ viewport: { width: 390, height: 844 } });

/** The page's htmx, for its config (src/web/layout/layout.tsx, HTMX_CONFIG). */
interface HtmxWindow {
  htmx: { config: { timeout: number } };
}

/** A POST whose redirect names the new row; its id. */
async function created(
  page: Page,
  url: string,
  form: Record<string, string>,
  pattern: RegExp,
): Promise<number> {
  const res = await page.request.post(url, {
    form,
    headers: SAME_ORIGIN,
    maxRedirects: 0,
  });
  expect(res.status()).toBe(302);
  return Number(pattern.exec(res.headers().location ?? '')?.[1]);
}

test('mark an outfit worn, wash it, log a wear alone, and do the laundry', async ({
  page,
}) => {
  const errors = pageErrors(page);
  await signIn(page, 'wears');
  const garment = (name: string, quantity: string) =>
    created(
      page,
      '/wardrobe',
      { name, category: 'tops', care: '1', quantity },
      /^\/wardrobe\/(\d+)\?/,
    );
  const oxford = await garment('Oxford', '1');
  const tees = await garment('White tees', '3');
  const outfit = await created(
    page,
    '/outfits',
    { name: 'Office', category: 'tops', garmentId: String(oxford) },
    /^\/outfits\/(\d+)$/,
  );
  const scheduled = await page.request.post('/calendar', {
    form: { date: householdToday(), outfitId: String(outfit) },
    headers: SAME_ORIGIN,
  });
  expect(scheduled.ok()).toBe(true);

  // The worn pill swaps in place.
  await page.goto('/calendar');
  await page.getByRole('button', { name: 'Wore it' }).click();
  await expect(page.getByText('✓ Worn', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();

  // The outfit's garment has the wear; Washed answers the section.
  await page.goto(`/wardrobe/${oxford}`);
  const wear = page.locator('#garment-wear');
  await expect(wear.getByText('Worn once')).toBeVisible();
  await expect(wear.getByText('Worn today (calendar)')).toBeVisible();
  await expect(wear.getByText('Needs a wash')).toBeVisible();
  await wear.getByRole('button', { name: 'Washed' }).click();
  await expect(wear.getByText('0 since washed')).toBeVisible();
  await expect(wear.getByText('Needs a wash')).toBeHidden();

  // One of three tees worn alone, then lent (the note appears).
  await page.goto(`/wardrobe/${tees}`);
  await expect(page.getByText('3 identical')).toBeVisible();
  await page.getByRole('button', { name: 'Wore today' }).click();
  await expect(page.getByText('1 of 3 need a wash')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Undo “Wore today”' }),
  ).toBeVisible();

  // The wardrobe prompts the laundry; Mark washed empties the hamper.
  await page.goto('/wardrobe');
  await expect(page.getByText('1 garment needs a wash')).toBeVisible();
  await page
    .locator('#wardrobe-main')
    .getByRole('link', { name: 'Laundry' })
    .click();
  await expect(
    page.getByRole('tab', { name: 'Laundry', selected: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: 'White tees' }),
  ).toBeChecked();
  await page.getByRole('button', { name: 'Mark washed' }).click();
  await expect(page.getByText('1 washed')).toBeVisible();
  await expect(page.getByText('Nothing needs a wash.')).toBeVisible();

  await page.goto(`/wardrobe/${tees}`);
  await page.getByRole('radio', { name: 'Lent' }).check();
  await expect(page.getByLabel('Where, or who has it')).toBeVisible();

  // A failed tap says so (#642). An autosave answered 503 (the owner lock's
  // answer, as the root error handler sends a fragment request: no body, the
  // HX-Trigger; test/integration/htmx-failures.spec.ts) toasts its message,
  // and the form it came from stays.
  const away = `**/wardrobe/${tees}/away*`;
  const toast = page.locator('#toast-host');
  await page.context().route(away, (route) =>
    route.fulfill({
      status: 503,
      headers: {
        'X-Request-ID': 'e2e000000503',
        'HX-Trigger': JSON.stringify({
          'closet:request-failed': {
            message: text('WARDROBE_BUSY'),
            requestId: 'e2e000000503',
          },
        }),
      },
    }),
  );
  await page.getByRole('radio', { name: 'At repair' }).check();
  await expect(toast).toContainText(text('WARDROBE_BUSY'));
  await expect(toast).toContainText('e2e000000503');
  await expect(page.getByLabel('Where, or who has it')).toBeVisible();
  await page.context().unroute(away);

  // A request with no answer gives up at htmx's timeout, the outbox's 15 s
  // (cut here to keep the scenario short), with a toast: held until the
  // toast shows, then let through.
  const htmxTimeout = () =>
    page.evaluate(() => (window as unknown as HtmxWindow).htmx.config.timeout);
  expect(await htmxTimeout()).toBe(REPLAY_TIMEOUT_MS);
  await page.evaluate(() => {
    (window as unknown as HtmxWindow).htmx.config.timeout = 500;
  });
  const held: Route[] = [];
  await page.context().route(away, (route) => void held.push(route));
  await page.getByRole('radio', { name: 'Lent' }).check();
  await expect(toast).toContainText(text('REQUEST_TIMED_OUT'));
  await page.context().unroute(away);
  // The page gave up on it, so the browser may have dropped it already.
  for (const route of held) await route.continue().catch(() => undefined);

  // A tile whose garment was deleted on another device opens the
  // not-found page: the boosted tap's error page, swapped in.
  await page.goto('/wardrobe');
  const tile = page
    .locator('#wardrobe-main')
    .getByRole('link', { name: /Oxford/ });
  await expect(tile).toBeVisible();
  const deleted = await page.request.delete(`/wardrobe/${oxford}`, {
    headers: SAME_ORIGIN,
  });
  expect(deleted.ok()).toBe(true);
  await tile.click();
  await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible();
  await expect(page.getByText(text('refusal.notFound.garment'))).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/wardrobe/${oxford}$`));

  expect(errors).toEqual([]);
});
