import { expect, type Locator, type Page, test } from '@playwright/test';
import { addDays } from '../src/web/calendar/calendar-date';
import { createGarment, createOutfit } from './support/e2e-data';
import { SAME_ORIGIN, signIn } from './support/e2e-session';
import { openGarmentMenu } from './support/garment-page';
import { householdToday } from './support/household-today';
import { pageErrors } from './support/page-errors';

/**
 * The app bar's back arrow goes back like a native app's (#105,
 * public/js/back.js): to the page the user came from, as history holds it,
 * when that page is in the app; to its fixed href only on a cold entry. A
 * trip back through history leaves the page after it forward in history
 * and adds no entry; the fallback adds one. At phone width, in the
 * installed-app config when the server runs with PWA_ENABLED (CI's).
 */

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const backArrow = (page: Page) =>
  page.locator('header.app-bar a[data-history-back]');

const historyLength = (page: Page) => page.evaluate(() => history.length);

/**
 * Taps the back arrow and waits for `to`; answers whether it went back in
 * history (no new entry) or forward to the arrow's href (one more).
 */
async function tapBack(page: Page, to: RegExp): Promise<{ wentBack: boolean }> {
  const before = await historyLength(page);
  await backArrow(page).click();
  await expect(page).toHaveURL(to);
  return { wentBack: (await historyLength(page)) === before };
}

/**
 * A finger's tap on a Styling strip's item: once the strip has come to rest
 * with the item centred, a click at the item's middle. Not `locator.click()`:
 * its scroll-into-view (retried with other alignments under load) scrolls a
 * snapping strip, which then settles on a neighbour, so the page would open
 * one garment and snapshot the row choosing another.
 */
async function tapCentredItem(page: Page, item: Locator): Promise<void> {
  await expect
    .poll(() =>
      item.evaluate((element) => {
        const strip = element.closest('.styling-strip')!;
        const a = element.getBoundingClientRect();
        const b = strip.getBoundingClientRect();
        return Math.abs(a.left + a.width / 2 - (b.left + b.width / 2)) < 2;
      }),
    )
    .toBe(true);
  const box = (await item.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test('wardrobe, a garment, back: the wardrobe, back in history', async ({
  page,
}) => {
  const errors = pageErrors(page, { console: true });
  await signIn(page, 'back-wardrobe');
  const id = await createGarment(page, 'Back tee');
  await page.goto('/wardrobe');

  await page.locator(`a[href="/wardrobe/${id}"]`).first().click();
  await expect(page).toHaveURL(new RegExp(`/wardrobe/${id}$`));
  await expect(page.locator('h1')).toHaveText('Back tee');

  expect(await tapBack(page, /\/wardrobe$/)).toEqual({ wentBack: true });
  await expect(page.locator('h1')).toHaveText('Wardrobe');
  // The garment is forward, as after the browser's own back.
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/wardrobe/${id}$`));
  expect(errors, errors.join('\n')).toEqual([]);
});

test('Styling, a garment, back: Styling with its rows as they were', async ({
  page,
}) => {
  const errors = pageErrors(page, { console: true });
  await signIn(page, 'back-styling');
  const oldTee = await createGarment(page, 'Old tee', 'tops');
  const newTee = await createGarment(page, 'New tee', 'tops');
  await createGarment(page, 'Jeans', 'bottoms');
  await page.goto('/styling');

  // Fresh, the row holds the newest tee; the person moves it to the old one.
  const tops = page.locator('[data-styling-row="top"]').first();
  const chosen = tops.locator('input[name="garmentId"]');
  await expect(chosen).toHaveValue(String(newTee));
  await tops.locator(`[data-garment-id="${oldTee}"]`).click();
  await expect(chosen).toHaveValue(String(oldTee));

  // A tap on the chosen garment opens its page.
  await tapCentredItem(page, tops.locator(`[data-garment-id="${oldTee}"]`));
  await expect(page).toHaveURL(new RegExp(`/wardrobe/${oldTee}$`));
  await expect(page.locator('h1')).toHaveText('Old tee');

  expect(await tapBack(page, /\/styling$/)).toEqual({ wentBack: true });
  await expect(page.locator('h1')).toHaveText('Styling');
  await expect(
    page
      .locator('[data-styling-row="top"]')
      .first()
      .locator('input[name="garmentId"]'),
  ).toHaveValue(String(oldTee));
  expect(errors, errors.join('\n')).toEqual([]);
});

test("the calendar's week, an outfit, back: that week", async ({ page }) => {
  const errors = pageErrors(page, { console: true });
  await signIn(page, 'back-calendar');
  const garment = await createGarment(page, 'Week top');
  const day = addDays(householdToday(), 14);
  await createOutfit(page, 'Fortnight look', garment, day);
  await page.goto(`/calendar?week=${day}`);

  await page.getByRole('link', { name: 'Fortnight look', exact: true }).click();
  await expect(page).toHaveURL(/\/styling\?outfit=\d+/);

  expect(await tapBack(page, new RegExp(`/calendar\\?week=${day}`))).toEqual({
    wentBack: true,
  });
  await expect(page.locator(`section[data-day="${day}"]`)).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('a deep link to a garment, back: the wardrobe, its fixed parent', async ({
  page,
}) => {
  const errors = pageErrors(page, { console: true });
  await signIn(page, 'back-deep-link');
  const id = await createGarment(page, 'Shared tee');
  // A new tab on the garment: nothing of the app's before it.
  const tab = await page.context().newPage();
  await tab.goto(`/wardrobe/${id}`);
  await expect(tab.locator('h1')).toHaveText('Shared tee');

  expect(await tapBack(tab, /\/wardrobe$/)).toEqual({ wentBack: false });
  await expect(tab.locator('h1')).toHaveText('Wardrobe');
  await tab.close();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('Styling, a garment, Edit, Save, back: Styling, never the form', async ({
  page,
}) => {
  const errors = pageErrors(page, { console: true });
  await signIn(page, 'back-after-save');
  const tee = await createGarment(page, 'Edited tee', 'tops');
  await page.goto('/styling');

  const tops = page.locator('[data-styling-row="top"]').first();
  await tapCentredItem(page, tops.locator(`[data-garment-id="${tee}"]`));
  await expect(page).toHaveURL(new RegExp(`/wardrobe/${tee}$`));

  const menu = await openGarmentMenu(page);
  await menu.getByRole('link', { name: 'Edit' }).click();
  await expect(page).toHaveURL(new RegExp(`/wardrobe/${tee}/edit`));
  await page.getByRole('textbox', { name: 'Name' }).fill('Renamed tee');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/wardrobe/${tee}$`));
  await expect(page.locator('h1')).toHaveText('Renamed tee');

  // Back past the form and the garment as it was before the edit.
  await backArrow(page).click();
  await expect(page).toHaveURL(/\/styling$/);
  await expect(page.locator('h1')).toHaveText('Styling');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('wardrobe, a garment, Edit, Save, back: the wardrobe shows the save', async ({
  page,
}) => {
  const errors = pageErrors(page, { console: true });
  await signIn(page, 'back-save-fresh');
  const tee = await createGarment(page, 'Before tee', 'tops');
  await page.goto('/wardrobe');
  const tile = page.locator(`main a[href="/wardrobe/${tee}"]`).first();
  await expect(tile).toContainText('Before tee');
  await tile.click();
  await expect(page).toHaveURL(new RegExp(`/wardrobe/${tee}$`));

  const menu = await openGarmentMenu(page);
  await menu.getByRole('link', { name: 'Edit' }).click();
  await page.getByRole('textbox', { name: 'Name' }).fill('After tee');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('h1')).toHaveText('After tee');

  // Back lands on the wardrobe as it is now, not htmx's snapshot from
  // before the save.
  await backArrow(page).click();
  await expect(page).toHaveURL(/\/wardrobe$/);
  await expect(tile).toContainText('After tee');
  await expect(page.locator('main').getByText('Before tee')).toHaveCount(0);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('a reload (pull to refresh) keeps the way back', async ({ page }) => {
  const errors = pageErrors(page, { console: true });
  await signIn(page, 'back-reload');
  const id = await createGarment(page, 'Reloaded tee');
  await page.goto('/wardrobe');
  await page.locator(`a[href="/wardrobe/${id}"]`).first().click();
  await expect(page).toHaveURL(new RegExp(`/wardrobe/${id}$`));

  // location.reload(), as pull to refresh does: Playwright's own reload in
  // Firefox makes a new history entry, which no person's reload does.
  await Promise.all([
    page.waitForEvent('load'),
    page.evaluate(() => location.reload()),
  ]);
  await expect(page.locator('h1')).toHaveText('Reloaded tee');
  expect(await tapBack(page, /\/wardrobe$/)).toEqual({ wentBack: true });
  expect(errors, errors.join('\n')).toEqual([]);
});

test('Insights, another window, back: Insights as it was, not the wardrobe', async ({
  page,
}) => {
  const errors = pageErrors(page, { console: true });
  await signIn(page, 'back-insights');
  await createGarment(page, 'Idle tee');
  await page.goto('/wardrobe/insights');
  await page.locator('a[href^="/wardrobe/insights?unworn=30"]').click();
  await expect(page).toHaveURL(/\/wardrobe\/insights\?unworn=30/);

  // A query of the same page is a place of its own outside a form's save.
  expect(await tapBack(page, /\/wardrobe\/insights(#[\w-]*)?$/)).toEqual({
    wentBack: true,
  });
  expect(errors, errors.join('\n')).toEqual([]);
});

test('an outfit, Edit in Styling, Save, back: the outfits, never the editor', async ({
  page,
}) => {
  const errors = pageErrors(page, { console: true });
  await signIn(page, 'back-styling-save');
  const tee = await createGarment(page, 'Styled tee', 'tops');
  const outfit = await createOutfit(page, 'Tuesday', tee);
  await page.goto('/outfits');
  await page.locator(`[data-outfit-id="${outfit}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/outfits/${outfit}$`));

  await page.getByRole('link', { name: 'Edit in Styling' }).click();
  await expect(page).toHaveURL(new RegExp(`/styling\\?outfit=${outfit}`));
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page
    .locator('#styling-save')
    .getByRole('button', { name: 'Save changes' })
    .click();
  await expect(page).toHaveURL(new RegExp(`/outfits/${outfit}$`));

  await backArrow(page).click();
  await expect(page).toHaveURL(/\/outfits$/);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('a garment, Edit, Cancel, back: the wardrobe, never the form', async ({
  page,
}) => {
  const errors = pageErrors(page, { console: true });
  await signIn(page, 'back-cancel');
  const id = await createGarment(page, 'Cancelled tee');
  await page.goto('/wardrobe');
  await page.locator(`main a[href="/wardrobe/${id}"]`).first().click();
  const menu = await openGarmentMenu(page);
  await menu.getByRole('link', { name: 'Edit' }).click();
  await expect(page).toHaveURL(new RegExp(`/wardrobe/${id}/edit`));

  // Cancel is a back arrow: back to the garment, no new entry.
  const before = await historyLength(page);
  await page.getByRole('link', { name: 'Cancel' }).click();
  await expect(page).toHaveURL(new RegExp(`/wardrobe/${id}$`));
  expect(await historyLength(page)).toBe(before);
  expect(await tapBack(page, /\/wardrobe$/)).toEqual({ wentBack: true });

  // Cold (a new tab on the form): Cancel goes forward to the garment, which
  // then goes back past the abandoned form to its own parent.
  const tab = await page.context().newPage();
  await tab.goto(`/wardrobe/${id}/edit`);
  await tab.getByRole('link', { name: 'Cancel' }).click();
  await expect(tab).toHaveURL(new RegExp(`/wardrobe/${id}$`));
  expect(await tapBack(tab, /\/wardrobe$/)).toEqual({ wentBack: false });
  await tab.close();
  expect(errors, errors.join('\n')).toEqual([]);
});

test("the back logs never name a secret path (an invite's token)", async ({
  page,
}) => {
  const messages: string[] = [];
  page.on('console', (msg) => messages.push(msg.text()));
  await signIn(page, 'back-secret');
  const invite = await page.request.post('/wardrobe-share/create-invite-link', {
    form: { permission: 'VIEW' },
    headers: { ...SAME_ORIGIN, 'hx-request': 'true' },
  });
  const token = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(
    await invite.text(),
  )![1];

  await page.goto(`/wardrobe-share/invite/${token}`);
  await expect(page.locator('h1')).toBeVisible();
  await expect
    .poll(() => messages.filter((text) => text.startsWith('[back]')))
    .toContain('[back] cold entry at /wardrobe-share');
  expect(messages.filter((text) => text.includes(token))).toEqual([]);
});
