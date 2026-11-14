import { expect, test as base } from '@playwright/test';

/**
 * Every spec's `test`: the page fails the scenario if the app raises a native
 * dialog (alert, confirm, prompt). The app asks through its own sheet
 * (public/js/confirm-sheet.js, #686); the browser's box is the server host's
 * unstyled title. Specs import `test` and `expect` from here, never from
 * @playwright/test.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    const dialogs: string[] = [];
    page.on('dialog', (dialog) => {
      dialogs.push(`${dialog.type()}: ${dialog.message()}`);
      void dialog.dismiss();
    });
    await use(page);
    expect(dialogs, 'native dialogs the app raised').toEqual([]);
  },
});

export { expect };
