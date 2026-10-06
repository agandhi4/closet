import { expect, type Page, test } from '@playwright/test';
import { createGarment } from './support/e2e-data';
import { signIn } from './support/e2e-session';
import { pageErrors } from './support/page-errors';

/**
 * The shared snap strip with a mouse (#311): previous/next buttons and the
 * arrow keys move the choice through the same observer a swipe does, and on
 * a phone the buttons are not there. Screenshots land in test-results/.
 */

async function wardrobe(page: Page, user: string) {
  await signIn(page, user);
  const oldTee = await createGarment(page, 'Old tee', 'tops');
  const newTee = await createGarment(page, 'New tee', 'tops');
  const midTee = await createGarment(page, 'Mid tee', 'tops');
  await page.goto('/styling');
  return { oldTee, newTee, midTee };
}

test.describe('with a mouse', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.skip(
    ({ isMobile }) => isMobile,
    'the mobile projects have a coarse pointer: no step buttons',
  );

  test('buttons and arrow keys move a strip and its value', async ({
    page,
  }) => {
    const errors = pageErrors(page, { console: true });
    const g = await wardrobe(page, 'strip-pointer');
    const tops = page.locator('[data-styling-row="top"]').first();
    const value = tops.locator('input[name="garmentId"]');
    const previous = tops.getByRole('button', {
      name: 'Previous: Top: choose one',
    });
    const next = tops.getByRole('button', { name: 'Next: Top: choose one' });
    await expect(value).toHaveValue(String(g.midTee));

    // Newest first: the next item is the older tee, then back.
    await next.click();
    await expect(value).toHaveValue(String(g.newTee));
    await previous.click();
    await expect(value).toHaveValue(String(g.midTee));

    // Two quick presses go two items on: the second does not repeat the first.
    await next.dblclick();
    await expect(value).toHaveValue(String(g.oldTee));
    await previous.dblclick();
    await expect(value).toHaveValue(String(g.midTee));

    // Arrow keys with focus in the strip (an item).
    await tops.locator('.styling-strip [data-snap-item]').nth(1).focus();
    await page.keyboard.press('ArrowRight');
    await expect(value).toHaveValue(String(g.newTee));
    await expect(page.locator(':focus')).toHaveAttribute(
      'data-snap-value',
      String(g.newTee),
    );
    await page.keyboard.press('ArrowLeft');
    await expect(value).toHaveValue(String(g.midTee));

    // A locked row does not move, and shows no buttons that would do nothing.
    await tops.locator('label.swap').click();
    await expect(next).toBeHidden();
    await expect(previous).toBeHidden();

    // The first item is whole at 1440 px: nothing clips it.
    const strip = tops.locator('.styling-strip');
    await strip.evaluate((el) => el.scrollTo({ left: 0, behavior: 'instant' }));
    const first = (await tops
      .locator('[data-snap-item]')
      .first()
      .boundingBox())!;
    const frame = (await strip.boundingBox())!;
    expect(first.x).toBeGreaterThanOrEqual(frame.x);

    await page.screenshot({ path: 'test-results/311-styling-1440.png' });
    expect(errors).toEqual([]);
  });
});

/**
 * A wishlist item whose "Goes with my closet" makes `bottoms.length`
 * outfits (one per bottom: no footwear), so its best-outfits strip holds
 * that many display-only cards. Returns its page.
 */
async function goesWithStrip(page: Page, user: string, bottoms: string[]) {
  await signIn(page, user);
  for (const name of bottoms) await createGarment(page, name, 'bottoms');
  const item = await createGarment(page, 'Merino knit', 'tops', {
    to: 'wishlist',
    wishlist: '1',
    replaces: '',
  });
  await page.goto(`/wardrobe/${item}`);
  return page.locator('[data-goes-with-strip]');
}

test.describe('a strip of tiles with no focusable parts', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('the strip itself takes focus and the arrow keys move it', async ({
    page,
  }) => {
    const strip = await goesWithStrip(page, 'strip-focus', ['Chinos', 'Jeans']);
    const cards = strip.locator('[data-snap-item]');
    await expect(cards).toHaveCount(2);
    await expect(strip).toHaveAttribute('tabindex', '0');
    const frame = strip.locator('xpath=..');
    const [previous, next] = [
      frame.locator('[data-snap-step="-1"]'),
      frame.locator('[data-snap-step="1"]'),
    ];
    await strip.focus();
    await expect(cards.first()).toHaveAttribute('data-selected', '');
    if (!test.info().project.use.isMobile) {
      await expect(previous).toBeDisabled();
      await expect(next).toBeEnabled();
    }
    await page.keyboard.press('ArrowRight');
    await expect(cards.nth(1)).toHaveAttribute('data-selected', '');
    await expect(strip).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(cards.first()).toHaveAttribute('data-selected', '');
  });
});

test('a strip of one item has both step buttons disabled', async ({ page }) => {
  const strip = await goesWithStrip(page, 'strip-single', ['Chinos']);
  await expect(strip.locator('[data-snap-item]')).toHaveCount(1);
  const frame = strip.locator('xpath=..');
  await expect(frame.locator('[data-snap-step="-1"]')).toBeDisabled();
  await expect(frame.locator('[data-snap-step="1"]')).toBeDisabled();
});

test.describe('on a phone', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });

  test('the step buttons are not shown', async ({ page }) => {
    await wardrobe(page, 'strip-touch');
    const tops = page.locator('[data-styling-row="top"]').first();
    await expect(
      tops.getByRole('button', { name: 'Next: Top: choose one' }),
    ).toBeHidden();
    await page.screenshot({ path: 'test-results/311-styling-390.png' });
  });
});

test.describe('the idea strips (#321)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.skip(
    ({ isMobile }) => isMobile,
    'the mobile projects have a coarse pointer: no step buttons',
  );

  test('Ideas and Today step with the buttons, and the page keeps its width', async ({
    page,
  }) => {
    const errors = pageErrors(page, { console: true });
    await signIn(page, 'strip-ideas');
    for (const [name, category, color] of [
      ['White tee', 'tops', 'white'],
      ['Grey tee', 'tops', 'grey'],
      ['Black tee', 'tops', 'black'],
      ['Raw jeans', 'bottoms', 'blue'],
      ['Khaki chinos', 'bottoms', 'beige'],
      ['White sneakers', 'footwear', 'white'],
    ] as const) {
      await createGarment(page, name, category, { color });
    }

    for (const [path, strip] of [
      ['/outfits/ideas', page.locator('#idea-strip')],
      ['/', page.locator('[data-today-row] [data-snap-strip]').first()],
    ] as const) {
      await page.goto(path);
      const frame = strip.locator('xpath=..');
      const cards = strip.locator('[data-idea]');
      await expect(cards.first()).toHaveAttribute('data-selected', '');
      await frame.locator('[data-snap-step="1"]').click();
      await expect(cards.nth(1)).toHaveAttribute('data-selected', '');
      await expect(cards.first()).not.toHaveAttribute('data-selected', '');
      // Photos stay large: a card is at least 200 px wide at 1440.
      expect((await cards.first().boundingBox())!.width).toBeGreaterThan(200);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(1440);
    }
    expect(errors).toEqual([]);
  });

  test("one click on a neighbouring idea card's button does its work", async ({
    page,
  }) => {
    await signIn(page, 'strip-tap-through');
    for (const [name, category, color] of [
      ['White tee', 'tops', 'white'],
      ['Grey tee', 'tops', 'grey'],
      ['Raw jeans', 'bottoms', 'blue'],
      ['Khaki chinos', 'bottoms', 'beige'],
      ['White sneakers', 'footwear', 'white'],
    ] as const) {
      await createGarment(page, name, category, { color });
    }
    await page.goto('/outfits/ideas');
    const second = page.locator('#idea-strip [data-idea]').nth(1);
    await expect(second).not.toHaveAttribute('data-selected', '');
    await second.locator('summary').click();
    await expect(second.locator('details')).toHaveAttribute('open', '');
  });
});
