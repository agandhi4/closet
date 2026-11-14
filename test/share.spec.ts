import { type Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { createGarment } from './support/e2e-data';
import {
  registerElsewhere,
  SAME_ORIGIN,
  signIn,
  submitLogin,
} from './support/e2e-session';

/**
 * Sharing a wardrobe, as the grantee sees it on a phone: the invite opened
 * signed out survives signing in (#661), Accept opens the grantor's
 * wardrobe, and the title's switcher opens it as a boosted swap (the
 * document and the service worker's page stay; the mark below proves it).
 * The share's lifecycle and permissions are
 * test/integration/share-lifecycle.spec.ts.
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

test('an invite opened signed out is accepted in one pass, and the shared wardrobe is a boosted swap', async ({
  page,
  browser,
  playwright,
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

  // The partner already has an account, and opens the link signed out.
  const granteeEmail = await registerElsewhere(
    playwright,
    'nav-switch-grantee',
  );
  const granteeContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const grantee = await granteeContext.newPage();
  const invitePage = `/wardrobe-share/invite/${token}`;
  await grantee.goto(invitePage);
  await grantee.locator('main').getByRole('link', { name: 'Login' }).click();
  await submitLogin(grantee, granteeEmail);
  // Back on the invite, signed in: Accept is one tap.
  await expect(grantee).toHaveURL(new RegExp(`${invitePage}$`));
  await grantee.getByRole('button', { name: 'Accept' }).click();
  await expect(grantee).toHaveURL(/\/wardrobe\?ownerId=\d+$/);
  await expect(grantee.getByText('Shared coat')).toBeVisible();

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
