import { expect, type Locator, type Page, test } from '@playwright/test';
import { createGarment } from './support/e2e-data';
import { signIn } from './support/e2e-session';
import { blockingScrollListeners } from './support/scroll-listeners';
import { pageErrors } from './support/page-errors';
import { MOBILE_WEBKIT_CANNOT_SWIPE } from './support/webkit-limits';

/**
 * Styling (#42) in a phone-sized browser: the strips are the browser's own
 * scroll-snap (a wheel or a swipe moves the choice, a tap on a neighbour
 * centres it) and public/js/styling.js writes the centred garment into the
 * row's field; Lock, Shuffle and the Save sheet. The integration tier
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
