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
 * Until `strip` has stopped on its chosen item: at once when the item sits
 * centred, else at the strip's `scrollend`. Event-driven, never counting
 * frames (#486): call it once the choice has moved (the observer marks the
 * item as it crosses the centre, mid-scroll), so the chosen item is where
 * the strip is going.
 */
async function settled(strip: Locator) {
  await strip.evaluate(
    (el) =>
      new Promise<void>((resolve) => {
        const centred = () => {
          const item = el.querySelector('[data-selected]')!;
          const box = el.getBoundingClientRect();
          const at = item.getBoundingClientRect();
          return (
            Math.abs(at.left + at.width / 2 - (box.left + box.width / 2)) < 1
          );
        };
        if (centred()) return resolve();
        el.addEventListener('scrollend', function landed() {
          if (!centred()) return;
          el.removeEventListener('scrollend', landed);
          resolve();
        });
      }),
  );
}

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
  await settled(strip);
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
 * Arrow keys as the keyboard sends them, to whatever has focus when each
 * arrives, all in one task: no frame, observer callback or `scrollend` runs
 * between them, so every key after the first lands while the strip's
 * scroll is in flight, the window #469's edges lived in. Then `after`, in
 * the same task. Returns the focused item's value after each key.
 */
function keysInFlight(
  strip: Locator,
  keys: string[],
  after: 'click-focused' | 'focus-lock' | 'none' = 'none',
) {
  return strip.evaluate(
    (el, { keys, after }) => {
      const trail = keys.map((key, i) => {
        document.activeElement!.dispatchEvent(
          new KeyboardEvent('keydown', {
            key,
            repeat: i > 0 && key === keys[i - 1],
            bubbles: true,
            cancelable: true,
          }),
        );
        // An item by its value; anything else (<body>) by its tag.
        const focused = document.activeElement as HTMLElement;
        return focused.dataset.snapValue ?? focused.tagName;
      });
      // Enter on a focused link or button is a click on it.
      if (after === 'click-focused') {
        (document.activeElement as HTMLElement).click();
      }
      if (after === 'focus-lock') {
        el.closest('[data-styling-row]')!
          .querySelector<HTMLElement>('.styling-lock')!
          .focus();
      }
      return trail;
    },
    { keys, after },
  );
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

  // The keyboard (#311, #469): an arrow on a focused item moves focus to
  // the step's target at once, so nothing acts on the item being left and
  // nothing moves focus later. The strip is [No garment, new tee, old tee].
  const strip = tops.locator('.styling-strip');
  const item = (value: string | number) =>
    strip.locator(`[data-snap-value="${value}"]`);
  const [previous, next] = [
    tops.locator('[data-snap-step="-1"]'),
    tops.locator('[data-snap-step="1"]'),
  ];
  const lock = tops.getByRole('checkbox', { name: 'Lock Top' });
  await expect(previous).toBeEnabled();
  await expect(next).toBeEnabled();
  await item(g.newTee).focus();
  await test.step('focus moved away mid-scroll stays where it went', async () => {
    expect(await keysInFlight(strip, ['ArrowLeft'], 'focus-lock')).toEqual([
      '',
    ]);
    await expect(chosen(tops)).toHaveValue('');
    await expect(lock).toBeFocused();
    await expect(lock).not.toBeChecked();
    await settled(strip);
  });
  await test.step('a held arrow keeps focus on each step’s item', async () => {
    await item('').focus();
    // The third repeat has nowhere to go: focus stays on the last item.
    expect(
      await keysInFlight(strip, ['ArrowRight', 'ArrowRight', 'ArrowRight']),
    ).toEqual([String(g.newTee), String(g.oldTee), String(g.oldTee)]);
    await expect(chosen(tops)).toHaveValue(String(g.oldTee));
    await expect(item(g.oldTee)).toBeFocused();
    await expect(next).toBeDisabled();
    await expect(previous).toBeEnabled();
    await settled(strip);
  });
  await test.step('Enter right after an arrow acts on its item', async () => {
    // The new tee is not chosen yet, so Enter centres it rather than
    // opening the old tee, the item the arrow left.
    expect(await keysInFlight(strip, ['ArrowLeft'], 'click-focused')).toEqual([
      String(g.newTee),
    ]);
    await expect(chosen(tops)).toHaveValue(String(g.newTee));
    await expect(item(g.newTee)).toBeFocused();
    await expect(page).toHaveURL(/\/styling$/);
    await settled(strip);
  });

  // A swipe is the strip's own scrolling: wheel it one item on and the
  // older tee snaps to the centre and becomes the choice.
  const box = (await strip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(box.width / 3, 0);
  await expect(chosen(tops)).toHaveValue(String(g.oldTee));
  // The preview follows without a request (styling.js, #468; shown from
  // lg, kept in step at every width): the top row's slot holds its look.
  const topSlot = page.locator('#styling-preview [data-preview-slot="0"]');
  await expect(topSlot).toHaveAttribute(
    'data-preview-garment',
    String(g.oldTee),
  );
  await expect(topSlot.locator('svg, img')).toHaveCount(1);

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
  // Locked, the old tee's neighbour is inert: no step goes to it.
  await expect(previous).toBeEnabled();
  await tops.locator('label.swap').click();
  await expect(lock).toBeChecked();
  await expect(tops.locator('input[name="lock"]')).toHaveValue('1');
  await expect(previous).toBeDisabled();
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
