import { expect, type Page } from '@playwright/test';
import { SAME_ORIGIN } from './e2e-session';

/**
 * The signed-in user's rows, made through the app's own POST routes with the
 * page's session (test/support/e2e-session.ts). Each returns the new row's
 * id, read from the page the post redirects to.
 */

function idOf(url: string): number {
  return Number(new URL(url).pathname.split('/').pop());
}

export async function createGarment(
  page: Page,
  name: string,
  category = 'tops',
  fields: Record<string, string> = {},
): Promise<number> {
  const res = await page.request.post('/wardrobe', {
    form: { name, category, ...fields },
    headers: SAME_ORIGIN,
  });
  expect(res.ok()).toBe(true);
  return idOf(res.url());
}

/** An outfit of one garment, scheduled on `scheduleDate` when given. */
export async function createOutfit(
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
  return idOf(res.url());
}

export async function createCapsule(page: Page, name: string): Promise<number> {
  const res = await page.request.post('/capsules', {
    form: { name },
    headers: SAME_ORIGIN,
  });
  expect(res.ok()).toBe(true);
  return idOf(res.url());
}
