import { expect, type Locator, type Page } from '@playwright/test';

/**
 * The garment page's app bar ⋯ menu and photo sheet (#84), opened the way
 * a person does: the menu by its button, the sheet from the menu.
 */

/** Opens the ⋯ menu; returns it. */
export async function openGarmentMenu(page: Page): Promise<Locator> {
  const menu = page.locator('#garment-menu');
  await menu.locator('summary').click();
  await expect(menu.getByRole('list')).toBeVisible();
  return menu;
}

/** Opens the photo sheet through the menu; returns the sheet. */
export async function openPhotoSheet(page: Page): Promise<Locator> {
  const menu = await openGarmentMenu(page);
  await menu
    .getByRole('button', { name: /^(Add a photo|Change photo)$/ })
    .click();
  const sheet = page.locator('#garment-photo-sheet');
  await expect(sheet).toBeVisible();
  return sheet;
}
