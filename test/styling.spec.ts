import { expect, type Locator, type Page, test } from '@playwright/test';
import { createGarment, createOutfit } from './support/e2e-data';
import { signIn } from './support/e2e-session';
import { pageErrors } from './support/page-errors';
import { MOBILE_WEBKIT_CANNOT_SWIPE } from './support/webkit-limits';

/**
 * Styling (#42) in a phone-sized browser: the strips are the browser's own
 * scroll-snap (a wheel or a swipe moves the choice, a tap on a neighbour
 * centres it) and public/js/styling.js writes the centred garment into the
 * row's field; Lock, Shuffle and the Save sheet; an outfit opened to edit;
 * and the page's bar above the dock, never over it. The integration tier
 * (test/integration/styling.spec.ts) covers each request's server side.
 */

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const row = (page: Page, role: string) =>
  page.locator(`[data-styling-row="${role}"]`).first();

/** The garment a row holds, as Save and Shuffle post it. */
const chosen = (rowLocator: Locator) =>
  rowLocator.locator('input[name="garmentId"]');

/**
 * A thumb's tap on `role`'s garment where it shows in its strip, once the
 * strip has stopped scrolling. Not locator.click(): Playwright first scrolls
 * an element it judges out of view, and in a snapping strip that can centre
 * a peeking neighbour, make it the choice, and turn the tap into opening its
 * page (a CI flake under load, #113).
 */
async function tap(page: Page, rowLocator: Locator, garmentId: string) {
  const strip = rowLocator.locator('.styling-strip');
  await strip.scrollIntoViewIfNeeded();
  await strip.evaluate(
    (el) =>
      new Promise<void>((resolve) => {
        let last = el.scrollLeft;
        let still = 0;
        const tick = () => {
          if (el.scrollLeft === last) still += 1;
          else [last, still] = [el.scrollLeft, 0];
          if (still >= 3) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
  const box = (await strip.boundingBox())!;
  const item = (await strip
    .locator(`[data-snap-value="${garmentId}"]`)
    .boundingBox())!;
  const left = Math.max(box.x, item.x);
  const right = Math.min(box.x + box.width, item.x + item.width);
  expect(right - left, 'the garment shows in its strip').toBeGreaterThan(8);
  await page.mouse.click((left + right) / 2, item.y + item.height / 2);
}

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
  isMobile,
}) => {
  test.skip(browserName === 'webkit' && isMobile, MOBILE_WEBKIT_CANNOT_SWIPE);
  const errors = pageErrors(page, { console: true });
  await signIn(page, 'styling-save');
  const g = await wardrobe(page);

  await page.goto('/styling');
  await expect(page.locator('h1')).toHaveText('Styling');
  await expect(page.locator('[data-styling-row]')).toHaveCount(3);
  // The newest of each role, centred.
  const tops = row(page, 'top');
  await expect(chosen(tops)).toHaveValue(String(g.newTee));
  await expect(tops.locator('[data-selected]')).toHaveAttribute(
    'data-snap-value',
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
  await tap(page, bottoms, '');
  await expect(chosen(bottoms)).toHaveValue('');
  await tap(page, bottoms, String(g.jeans));
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

  // The listeners are read through the DevTools protocol, Chromium's alone.
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

/** Where a strip is scrolled to, in whole pixels. */
const scrollLeft = (strip: Locator) =>
  strip.evaluate((el) => Math.round(el.scrollLeft));

/** Waits `count` animation frames: what an IntersectionObserver needs to report. */
const frames = (page: Page, count: number) =>
  page.evaluate(
    (n) =>
      new Promise<void>((resolve) => {
        const step = (left: number) =>
          left === 0 ? resolve() : requestAnimationFrame(() => step(left - 1));
        step(n);
      }),
    count,
  );

/**
 * The strip items Tab reaches from `rowLocator`'s lock until the focus
 * leaves the row (#146): their `data-snap-value`s, "" for "No garment".
 * Items only: Firefox also stops on the strip itself (a scroll container),
 * Chromium does not.
 */
async function tabbedItems(page: Page, rowLocator: Locator) {
  await rowLocator.locator('.styling-lock').focus();
  const reached: string[] = [];
  for (let presses = 0; presses < 20; presses++) {
    await page.keyboard.press('Tab');
    const focus = await rowLocator.evaluate((row) => {
      const el = document.activeElement;
      if (!el || !row.contains(el)) return { left: true, item: null };
      const item = el.matches('.styling-item')
        ? el.getAttribute('data-snap-value')
        : null;
      return { left: false, item };
    });
    if (focus.left) return reached;
    if (focus.item !== null) reached.push(focus.item);
  }
  throw new Error('Tab never left the row');
}

/** A sideways wheel over the middle of `strip`: what a swipe is to it. */
async function wheel(page: Page, strip: Locator, deltaX: number) {
  const box = (await strip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(deltaX, 0);
}

test('the chosen garment is ringed, and a locked row is frozen until unlocked (#106)', async ({
  page,
  browserName,
  isMobile,
}) => {
  test.skip(browserName === 'webkit' && isMobile, MOBILE_WEBKIT_CANNOT_SWIPE);
  const errors = pageErrors(page, { console: true });
  await signIn(page, 'styling-freeze');
  const g = await wardrobe(page);
  await page.goto('/styling');

  // The chosen item wears the ring, its neighbours none. Each item stops a
  // fling on its own, so a swipe moves one item at a time.
  const tops = row(page, 'top');
  const plinth = (id: number) =>
    tops.locator(`[data-snap-value="${id}"] > span`).first();
  await expect(tops.locator('[aria-selected="true"]')).toHaveAttribute(
    'data-snap-value',
    String(g.newTee),
  );
  await expect(plinth(g.newTee)).not.toHaveCSS('box-shadow', 'none');
  await expect(plinth(g.oldTee)).toHaveCSS('box-shadow', 'none');
  await expect(tops.locator('.styling-item').first()).toHaveCSS(
    'scroll-snap-stop',
    'always',
  );

  // Lock the top row: its strip no longer scrolls sideways (the page still
  // does), so a swipe leaves the new tee where it was.
  const strip = tops.locator('.styling-strip');
  await tops.locator('label.swap').click();
  await expect(strip).toHaveCSS('overflow-x', 'hidden');
  // Frozen sideways, but the page still scrolls and zooms over it.
  await expect(strip).toHaveCSS('touch-action', 'pan-y pinch-zoom');
  const frozenAt = await scrollLeft(strip);
  await wheel(page, strip, 200);
  // The same wheel on an unlocked row moves it: the attempt was real, and
  // was handled before the locked strip is measured again.
  const bottoms = row(page, 'bottom');
  await wheel(page, bottoms.locator('.styling-strip'), -200);
  await expect(chosen(bottoms)).toHaveValue('');
  expect(await scrollLeft(strip)).toBe(frozenAt);
  await expect(chosen(tops)).toHaveValue(String(g.newTee));
  // A tap on a neighbour neither centres it nor opens its page.
  await tap(page, tops, String(g.oldTee));
  await expect(page).toHaveURL(/\/styling$/);
  expect(await scrollLeft(strip)).toBe(frozenAt);
  await expect(chosen(tops)).toHaveValue(String(g.newTee));
  // Nor does the keyboard (#146): the frozen strip could not reveal a
  // focused neighbour, so the neighbours are inert and Tab goes from the
  // lock to the chosen garment, then on to the next row.
  expect(await tabbedItems(page, tops)).toEqual([String(g.newTee)]);
  // Whatever else scrolls it (a script can, even a hidden-overflow strip),
  // the strip comes back and the choice never moves.
  for (const item of [
    tops.locator('.styling-item').first(),
    tops.locator(`[data-snap-value="${g.oldTee}"]`),
  ]) {
    await item.evaluate((el) =>
      el.scrollIntoView({ inline: 'center', block: 'nearest' }),
    );
    // The strip's observer reports within a frame or two of the scroll.
    await frames(page, 5);
    expect(await scrollLeft(strip)).toBe(frozenAt);
    expect(await chosen(tops).inputValue()).toBe(String(g.newTee));
  }
  await expect(tops.locator('[aria-selected="true"]')).toHaveAttribute(
    'data-snap-value',
    String(g.newTee),
  );

  // Shuffle keeps the locked row, still frozen on the same garment.
  await page.getByRole('button', { name: /Shuffle/ }).click();
  await expect(page.locator('#styling-rows input[name="seed"]')).toHaveCount(1);
  const shuffledTops = row(page, 'top');
  const shuffledStrip = shuffledTops.locator('.styling-strip');
  await expect(chosen(shuffledTops)).toHaveValue(String(g.newTee));
  await expect(
    shuffledTops.getByRole('checkbox', { name: 'Lock Top' }),
  ).toBeChecked();
  await expect(shuffledStrip).toHaveCSS('overflow-x', 'hidden');
  await expect(chosen(row(page, 'bottom'))).toHaveValue(String(g.jeans));
  const shuffledAt = await scrollLeft(shuffledStrip);
  await wheel(page, shuffledStrip, 200);
  await wheel(page, row(page, 'bottom').locator('.styling-strip'), -200);
  await expect(chosen(row(page, 'bottom'))).toHaveValue('');
  expect(await scrollLeft(shuffledStrip)).toBe(shuffledAt);
  // The server rendered it locked: the keyboard still skips the neighbours.
  expect(await tabbedItems(page, shuffledTops)).toEqual([String(g.newTee)]);

  // Unlocked, it swipes again from the same item: one on is the old tee.
  await shuffledTops.locator('label.swap').click();
  await expect(shuffledStrip).toHaveCSS('overflow-x', 'auto');
  await wheel(page, shuffledStrip, 200);
  await expect(chosen(shuffledTops)).toHaveValue(String(g.oldTee));
  expect(await scrollLeft(shuffledStrip)).toBeGreaterThan(shuffledAt);
  // And Tab reaches every item again, "No garment" first. Last: focusing
  // one may scroll the unlocked strip to it, and so choose it.
  expect(await tabbedItems(page, shuffledTops)).toEqual([
    '',
    String(g.newTee),
    String(g.oldTee),
  ]);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('an outfit opened in Styling saves its changes in place', async ({
  page,
}) => {
  const errors = pageErrors(page, { console: true });
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
  await tap(page, row(page, 'bottom'), String(g.jeans));
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
  const lockBottom = bottoms.getByRole('checkbox', { name: 'Lock Bottom' });
  await expect(lockBottom).toBeChecked();
  // Locked from the server's first paint (#146): Tab skips the neighbours.
  expect(await tabbedItems(page, bottoms)).toEqual([String(g.jeans)]);
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
