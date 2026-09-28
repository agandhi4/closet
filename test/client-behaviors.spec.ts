import { expect, test } from '@playwright/test';
import { createGarment } from './support/e2e-data';
import { SAME_ORIGIN, signIn } from './support/e2e-session';
import { openGarmentMenu } from './support/garment-page';
import { pageErrors } from './support/page-errors';

/**
 * What _hyperscript used to do, done by htmx attributes, inline handlers
 * and CSS since it left the app: the wardrobe filter form, the outfit
 * list's "add to calendar" toast, the share link's copy button and the
 * garment page's self-hiding toast. The outfit builder's swipe and dialog
 * went with the builder: Styling's strips are test/styling.spec.ts's.
 */

test('the filter modal applies and clears filters, keeping the keyword', async ({
  page,
}) => {
  const errors = pageErrors(page, { console: true });
  await signIn(page, 'client-filters');
  await createGarment(page, 'Red tee', 'tops', { color: 'red' });
  await createGarment(page, 'Blue tee', 'tops', { color: 'blue' });
  await createGarment(page, 'Red scarf', 'scarves', { color: 'red' });
  await page.goto('/wardrobe');
  const tiles = page.locator('#wardrobe-grid > a');
  await expect(tiles).toHaveCount(3);

  // Search is its icon until tapped (the scope row, R3); typed, not yet sent.
  await page.locator('#search-form label').click();
  await page.getByRole('textbox', { name: 'Search' }).fill('tee');
  await page.getByRole('button', { name: 'Filters' }).click();
  const modal = page.locator('#filter-modal');
  await expect(modal).toBeVisible();
  await modal.getByText('red', { exact: true }).click();
  await modal.getByRole('button', { name: 'Apply Filters' }).click();

  await expect(page).toHaveURL(/color=red/);
  await expect(page).toHaveURL(/keyword=tee/);
  await expect(tiles).toHaveCount(1);
  await expect(tiles.first()).toContainText('Red tee');
  await expect(modal).toBeHidden();

  await page.getByRole('button', { name: 'Filters' }).click();
  await modal.getByRole('button', { name: 'Clear Filters' }).click();
  await expect(page).not.toHaveURL(/color=/);
  await expect(tiles).toHaveCount(2);
  expect(errors).toEqual([]);
});

test('the outfit page plans the outfit from its sheet and lands on that week', async ({
  page,
}) => {
  const errors = pageErrors(page, { console: true });
  await signIn(page, 'client-plan-sheet');
  const garment = await createGarment(page, 'Sheet tee', 'tops');
  const res = await page.request.post('/outfits', {
    form: { name: 'Sheet outfit', category: 'tops', garmentId: `${garment}` },
    headers: SAME_ORIGIN,
  });
  expect(res.ok()).toBe(true);
  await page.goto(res.url());

  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  const sheet = page.locator('#outfit-plan-sheet');
  await expect(sheet).toBeVisible();
  await sheet.locator('input[name="date"]').fill('2030-10-10');
  await sheet.getByRole('radio', { name: 'Evening' }).check();
  await sheet.getByRole('button', { name: 'Plan it' }).click();

  await expect(page).toHaveURL(/\/calendar\?week=2030-10-10/);
  await expect(page.getByText('Sheet outfit').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('the share button copies the link and flashes', async ({
  page,
  context,
  browserName,
}) => {
  // Chromium needs both permissions. WebKit lets a tap write without one
  // and never lets a page read the clipboard back (readText waits for the
  // paste menu), so there the flash, which only a resolved write starts,
  // and the link the tap writes are the proof.
  const readable = browserName === 'chromium';
  if (readable) {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  }
  await signIn(page, 'client-share');
  const id = await createGarment(page, 'Shared tee', 'tops');
  await page.goto(`/wardrobe/${id}`);

  // The garment page's Share is an item of its ⋯ menu (#84).
  const menu = await openGarmentMenu(page);
  const share = menu.getByRole('button', { name: 'Share' });
  const link = /\/share\?shareableId=[^&]+&type=garment$/;
  await expect(share).toHaveAttribute('data-copy', link);
  await share.click();
  await expect(share).toHaveClass(/\btext-success\b/);
  if (readable) {
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
      link,
    );
  }
  await expect(share).toHaveClass(/\btext-base-content\b/);
});

test('the "saved" toast hides itself', async ({ page }) => {
  await signIn(page, 'client-toast');
  const id = await createGarment(page, 'Toasted tee', 'tops');
  await page.goto(`/wardrobe/${id}?created=1`);
  const toast = page.locator('#garment-saved-toast');
  await expect(toast).toBeVisible();
  await expect(toast).toBeHidden({ timeout: 6000 });
});
