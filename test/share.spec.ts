import { expect, type Page, test } from '@playwright/test';
import { createGarment } from './support/e2e-data';
import { SAME_ORIGIN, signIn } from './support/e2e-session';

/**
 * Sharing a wardrobe, as the grantee sees it: the invite accepted, the
 * title's switcher opens the other wardrobe as a boosted swap (the document
 * and the service worker's page stay; the mark below proves it). The share's
 * lifecycle and permissions are test/integration/share-lifecycle.spec.ts.
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

test('switching to a shared wardrobe from the title is a boosted swap', async ({
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
  // The switcher is the title's menu (R3, #83).
  await grantee.locator('#title-menu summary').click();
  await grantee
    .locator('#title-menu')
    .getByRole('link', { name: /Can edit|View only/ })
    .click();

  await expect(grantee).toHaveURL(/\/wardrobe\?ownerId=\d+$/);
  await expect(grantee.getByText('Shared coat')).toBeVisible();
  await expect(
    grantee.getByRole('heading', { level: 1, name: /’s wardrobe$/ }),
  ).toBeVisible();
  await expectSameDocument(grantee);
  await granteeContext.close();
});
