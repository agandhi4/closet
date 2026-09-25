import { test, expect } from '@playwright/test';

const APP_NAME = process.env.APP_NAME || 'Closet';

test('root redirects to a page that renders APP_NAME without console errors', async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  // "/" is a 302 to /wardrobe (and on to /auth/login when AUTH_ENABLED);
  // goto follows redirects, so assert on the final page.
  await page.goto('/');
  expect(page.url()).not.toMatch(/\/$/);
  await expect(page.locator('body')).toContainText(APP_NAME);
  expect(
    consoleErrors,
    `Console errors found:\n${consoleErrors.join('\n')}`,
  ).toHaveLength(0);
});
