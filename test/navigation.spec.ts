import { expect, type Page, test } from '@playwright/test';
import { SAME_ORIGIN, signIn } from './support/e2e-session';

/**
 * Taps that used to reload the whole document (client audit H4) are htmx
 * navigations now: the document, its scripts and the service worker's page
 * stay, only the body (or #wardrobe-main) is swapped. Each test marks the
 * window first; a full load would lose the mark.
 */

async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as Window & { __sameDocument?: boolean }).__sameDocument = true;
  });
}

async function expectSameDocument(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () => (window as Window & { __sameDocument?: boolean }).__sameDocument,
    ),
  ).toBe(true);
}

async function createGarment(page: Page, name: string): Promise<number> {
  const res = await page.request.post('/wardrobe', {
    form: { name, category: 'tops' },
    headers: SAME_ORIGIN,
  });
  expect(res.ok()).toBe(true);
  return Number(new URL(res.url()).pathname.split('/').pop());
}

async function createOutfit(
  page: Page,
  name: string,
  garmentId: number,
  scheduleDate = '',
): Promise<number> {
  const res = await page.request.post('/outfits', {
    form: {
      name,
      category: 'tops',
      garmentId: String(garmentId),
      scheduleDate,
    },
    headers: SAME_ORIGIN,
  });
  expect(res.ok()).toBe(true);
  return Number(new URL(res.url()).pathname.split('/').pop());
}

test('deleting a garment swaps to the wardrobe (HX-Location)', async ({
  page,
}) => {
  await signIn(page, 'nav-delete');
  const id = await createGarment(page, 'Swapped away');
  await page.goto(`/wardrobe/${id}`);
  await markDocument(page);

  page.on('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Delete' }).click();

  await expect(page).toHaveURL(/\/wardrobe$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Wardrobe' }),
  ).toBeVisible();
  await expect(page.getByText('Swapped away')).toHaveCount(0);
  await expectSameDocument(page);
});

test('tapping an outfit card opens the outfit without a reload', async ({
  page,
}) => {
  await signIn(page, 'nav-outfit-card');
  const garment = await createGarment(page, 'Card top');
  const outfit = await createOutfit(page, 'Card outfit', garment);
  await page.goto('/outfits');
  await markDocument(page);

  // Anywhere on the card, not only the name: here, its thumbnails row.
  const card = page.locator(`[data-outfit-id="${outfit}"]`);
  const box = (await card.boundingBox())!;
  await card.click({ position: { x: 30, y: box.height - 20 } });

  await expect(page).toHaveURL(new RegExp(`/outfits/${outfit}$`));
  await expect(
    page.getByRole('heading', { level: 1, name: 'Card outfit' }),
  ).toBeVisible();
  await expectSameDocument(page);
});

test('tapping a calendar chip opens the outfit editor without a reload', async ({
  page,
}) => {
  await signIn(page, 'nav-calendar-chip');
  const garment = await createGarment(page, 'Chip top');
  const today = await page.evaluate(() =>
    new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
  );
  const outfit = await createOutfit(page, 'Chip outfit', garment, today);
  await page.goto(`/calendar?week=${today}`);
  await markDocument(page);

  await page.getByRole('link', { name: 'Chip outfit' }).click();

  await expect(page).toHaveURL(
    new RegExp(`/outfits/${outfit}/edit\\?returnTo=/calendar`),
  );
  await expect(
    page.getByRole('heading', { level: 1, name: 'Edit Outfit' }),
  ).toBeVisible();
  await expectSameDocument(page);
});

test('switching to a shared wardrobe swaps the grid in place', async ({
  page,
  browser,
}) => {
  await signIn(page, 'nav-switch-owner');
  await createGarment(page, 'Shared coat');
  const invite = await page.request.post('/wardrobe-share/create-invite-link', {
    form: { permission: 'VIEW' },
    headers: { ...SAME_ORIGIN, 'hx-request': 'true' },
  });
  const token = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(
    await invite.text(),
  )?.[1];
  expect(token).toBeDefined();

  const granteeContext = await browser.newContext();
  const grantee = await granteeContext.newPage();
  await signIn(grantee, 'nav-switch-grantee');
  const accepted = await grantee.request.post(
    `/wardrobe-share/invite/${token}/accept`,
    { headers: SAME_ORIGIN },
  );
  expect(accepted.ok()).toBe(true);

  await grantee.goto('/wardrobe');
  await markDocument(grantee);
  const switcher = grantee.getByRole('combobox', { name: 'My Wardrobe' });
  await switcher.selectOption({ index: 1 });

  await expect(grantee).toHaveURL(/\/wardrobe\?ownerId=\d+$/);
  await expect(grantee.getByText('Shared coat')).toBeVisible();
  await expectSameDocument(grantee);
  await granteeContext.close();
});
