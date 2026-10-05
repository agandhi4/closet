import type { Page } from '@playwright/test';

// Shared by test/styling.spec.ts and test/photo-viewer.spec.ts.
/**
 * The app's touch and wheel listeners that are not passive, on the window
 * and anywhere in the document: each would make the browser wait on script
 * before it scrolls a strip. Listeners from the page's own origin only
 * (Chromium's DevTools protocol names each one's script): Playwright's
 * injected scripts listen too, around its own clicks.
 */
export async function blockingScrollListeners(page: Page): Promise<string[]> {
  const client = await page.context().newCDPSession(page);
  const scripts = new Map<string, string>();
  client.on('Debugger.scriptParsed', (event) =>
    scripts.set(event.scriptId, event.url),
  );
  // Enabling reports every script already parsed.
  await client.send('Debugger.enable');
  const origin = new URL(page.url()).origin;
  const blocking: string[] = [];
  for (const target of ['window', 'document']) {
    const { result } = await client.send('Runtime.evaluate', {
      expression: target,
    });
    const { listeners } = await client.send('DOMDebugger.getEventListeners', {
      objectId: result.objectId!,
      depth: -1,
    });
    for (const listener of listeners) {
      const url = scripts.get(listener.scriptId) ?? '';
      if (
        /^(touchstart|touchmove|wheel)$/.test(listener.type) &&
        !listener.passive &&
        url.startsWith(origin)
      ) {
        blocking.push(`${listener.type} in ${url}:${listener.lineNumber}`);
      }
    }
  }
  await client.detach();
  return blocking;
}
