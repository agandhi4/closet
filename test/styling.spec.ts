import { expect, type Locator, type Page, test } from '@playwright/test';
import { createGarment, createOutfit } from './support/e2e-data';
import { signIn } from './support/e2e-session';

/**
 * Styling (#42) in a phone-sized browser: the strips are the browser's own
 * scroll-snap (a wheel or a swipe moves the choice, a tap on a neighbour
 * centres it) and public/js/styling.js writes the centred garment into the
 * row's field; Lock, Shuffle and the Save sheet; an outfit opened to edit;
 * and the page's bar above the dock, never over it. The integration tier
 * (test/integration/styling.spec.ts) covers each request's server side.
 */

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  return errors;
}

const row = (page: Page, role: string) =>
  page.locator(`[data-styling-row="${role}"]`).first();

/** The garment a row holds, as Save and Shuffle post it. */
const chosen = (rowLocator: Locator) =>
  rowLocator.locator('input[name="garmentId"]');

/**
 * The app's touch and wheel listeners that are not passive, on the window
 * and anywhere in the document: each would make the browser wait on script
 * before it scrolls a strip. Listeners from the page's own origin only
 * (Chromium's DevTools protocol names each one's script): Playwright's
 * injected scripts listen too, around its own clicks.
 */
async function blockingScrollListeners(page: Page): Promise<string[]> {
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

async function wardrobe(page: Page) {
  return {
    oldTee: await createGarment(page, 'Old tee', 'tops'),
    newTee: await createGarment(page, 'New tee', 'tops'),
    jeans: await createGarment(page, 'Jeans', 'bottoms'),
    boots: await createGarment(page, 'Boots', 'footwear'),
  };
}

test('style an outfit: swipe, tap, lock, shuffle and save through the sheet', async ({
  page,
  browserName,
}) => {
  const errors = collectErrors(page);
  await signIn(page, 'styling-save');
  const g = await wardrobe(page);

  await page.goto('/styling');
  await expect(page.locator('h1')).toHaveText('Styling');
  await expect(page.locator('[data-styling-row]')).toHaveCount(3);
  // The newest of each role, centred.
  const tops = row(page, 'top');
  await expect(chosen(tops)).toHaveValue(String(g.newTee));
  await expect(tops.locator('[data-selected]')).toHaveAttribute(
    'data-garment-id',
    String(g.newTee),
  );

  // A swipe is the strip's own scrolling: wheel it one item on and the
  // older tee snaps to the centre and becomes the choice.
  const strip = tops.locator('.styling-strip');
  const box = (await strip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(box.width / 3, 0);
  await expect(chosen(tops)).toHaveValue(String(g.oldTee));

  // A tap on the neighbour peeking at the left ("No garment") centres it;
  // a tap on the jeans brings them back.
  const bottoms = row(page, 'bottom');
  await bottoms.locator('[data-garment-id=""]').click();
  await expect(chosen(bottoms)).toHaveValue('');
  await bottoms.locator(`[data-garment-id="${g.jeans}"]`).click();
  await expect(chosen(bottoms)).toHaveValue(String(g.jeans));
  // Tapping the centred garment would open its page: the URL stays here.
  await expect(page).toHaveURL(/\/styling$/);

  // Lock the old tee, then Shuffle: it stays, the rest come from ideas.
  // The lock is daisyUI's swap: the label is what a thumb taps.
  await tops.locator('label.swap').click();
  await expect(tops.getByRole('checkbox', { name: 'Lock Top' })).toBeChecked();
  await expect(tops.locator('input[name="lock"]')).toHaveValue('1');
  await page.getByRole('button', { name: /Shuffle/ }).click();
  await expect(page.locator('#styling-rows input[name="seed"]')).toHaveCount(1);
  await expect(chosen(row(page, 'top'))).toHaveValue(String(g.oldTee));
  await expect(
    row(page, 'top').getByRole('checkbox', { name: 'Lock Top' }),
  ).toBeChecked();
  await expect(chosen(row(page, 'bottom'))).toHaveValue(String(g.jeans));
  await expect(chosen(row(page, 'footwear'))).toHaveValue(String(g.boots));

  if (browserName === 'chromium') {
    expect(await blockingScrollListeners(page)).toEqual([]);
  }

  // Save opens the sheet: name it and save.
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const sheet = page.locator('#styling-save');
  await expect(sheet).toBeVisible();
  await sheet.getByRole('textbox', { name: 'Name' }).fill('Playwright look');
  await sheet.getByRole('button', { name: 'Save outfit' }).click();
  await page.waitForURL(/\/outfits\/\d+$/);
  await expect(page.locator('h1')).toHaveText('Playwright look');
  // Top to toe, whatever order the rows were touched in.
  await expect(page.locator('main a[href^="/wardrobe/"]')).toHaveText([
    'Old tee',
    'Jeans',
    'Boots',
  ]);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('an outfit opened in Styling saves its changes in place', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await signIn(page, 'styling-edit');
  const g = await wardrobe(page);
  const outfit = await createOutfit(page, 'Monday', g.oldTee);

  await page.goto(`/outfits/${outfit}`);
  await page.getByRole('link', { name: 'Edit in Styling' }).click();
  await expect(page).toHaveURL(new RegExp(`/styling\\?outfit=${outfit}`));
  await expect(page.getByText('Changing Monday')).toBeVisible();
  await expect(chosen(row(page, 'top'))).toHaveValue(String(g.oldTee));
  // Its other roles open empty, ready to add.
  await expect(chosen(row(page, 'bottom'))).toHaveValue('');
  await row(page, 'bottom').locator(`[data-garment-id="${g.jeans}"]`).click();
  await expect(chosen(row(page, 'bottom'))).toHaveValue(String(g.jeans));

  await page.getByRole('button', { name: 'Save changes' }).click();
  const sheet = page.locator('#styling-save');
  await expect(sheet.getByRole('textbox', { name: 'Name' })).toHaveValue(
    'Monday',
  );
  await sheet.getByRole('button', { name: 'Save changes' }).click();
  await page.waitForURL(new RegExp(`/outfits/${outfit}$`));
  await expect(page.locator('main a[href^="/wardrobe/"]')).toHaveText([
    'Old tee',
    'Jeans',
  ]);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('"Style this" opens Styling locked on the garment', async ({ page }) => {
  await signIn(page, 'styling-this');
  const g = await wardrobe(page);
  await page.goto(`/wardrobe/${g.jeans}`);
  await page.getByRole('link', { name: 'Style this' }).click();
  await expect(page).toHaveURL(new RegExp(`/styling\\?with=${g.jeans}$`));
  const bottoms = row(page, 'bottom');
  await expect(chosen(bottoms)).toHaveValue(String(g.jeans));
  await expect(
    bottoms.getByRole('checkbox', { name: 'Lock Bottom' }),
  ).toBeChecked();
});

/**
 * Probes the dock's upper band and middle every 16 px: whatever the page
 * stacks there must be the dock itself (the #50 rule, test/dock.spec.ts).
 */
async function pointsOverTheDock(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const dock = document.querySelector('.dock')!;
    const box = dock.getBoundingClientRect();
    const blocked: string[] = [];
    for (const y of [box.top + 6, box.top + box.height / 2]) {
      for (let x = box.left + 4; x < box.right; x += 16) {
        const hit = document.elementFromPoint(x, y);
        if (hit && dock.contains(hit)) continue;
        blocked.push(`(${Math.round(x)}, ${Math.round(y)}): ${hit?.tagName}`);
      }
    }
    return blocked;
  });
}

test('the action bar sits above the dock, never over it', async ({ page }) => {
  await signIn(page, 'styling-dock');
  await wardrobe(page);
  await page.goto('/styling');
  await expect(page.locator('.dock a[aria-current="page"]')).toHaveAttribute(
    'href',
    '/styling',
  );
  const bar = page.locator('[data-styling-shuffle]').locator('xpath=../..');
  const [barBottom, dockTop] = await Promise.all([
    bar.evaluate((el) => el.getBoundingClientRect().bottom),
    page.locator('.dock').evaluate((el) => el.getBoundingClientRect().top),
  ]);
  expect(barBottom).toBeLessThanOrEqual(dockTop + 1);
  expect(await pointsOverTheDock(page)).toEqual([]);
  // The last row clears the bar: nothing of the outfit is hidden under it.
  await page.evaluate(() =>
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }),
  );
  const lastRow = page.locator('[data-styling-row]').last();
  const [rowBottom, barTop] = await Promise.all([
    lastRow.evaluate((el) => el.getBoundingClientRect().bottom),
    bar.evaluate((el) => el.getBoundingClientRect().top),
  ]);
  expect(rowBottom).toBeLessThanOrEqual(barTop);
  expect(await pointsOverTheDock(page)).toEqual([]);
});
