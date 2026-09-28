import type { Page } from '@playwright/test';

/**
 * WebKit logs "Fetch API cannot load <url> due to access control checks."
 * when it refuses a fetch because the document is being navigated away, and
 * Playwright's WebKit reports that line as a page error although the app
 * catches the rejection: connectivity.js's /healthz probe and the install
 * dialog's /manifest.json read, cut off by the next page (#179). The app
 * fetches nothing cross-origin (the CSP's connect-src is 'self'), so the
 * line is never a real access-control failure.
 */
const REFUSED_WHILE_LEAVING =
  /Fetch API cannot load \S+ due to access control checks\./;

/**
 * Collects what went wrong in the page while a spec runs, for it to assert
 * none: uncaught errors, and with `console`, console errors too.
 */
export function pageErrors(
  page: Page,
  options: { console?: boolean } = {},
): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    if (REFUSED_WHILE_LEAVING.test(error.stack ?? error.message)) return;
    errors.push(error.message);
  });
  if (options.console) {
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      if (REFUSED_WHILE_LEAVING.test(message.text())) return;
      errors.push(message.text());
    });
  }
  return errors;
}
