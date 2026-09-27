import { expect, type Page, test } from '@playwright/test';
import { createGarment } from './support/e2e-data';
import { signIn } from './support/e2e-session';
import { householdToday } from './support/household-today';

/**
 * The outfit gallery in a browser at phone width (#9): swiping the Ideas
 * strip is the browser's own scroll snapping (no carousel library, no touch
 * handlers), the sentinel loads the next page as the strip scrolls, a pick
 * from the calendar's plan page lands on the day, and offline the cards stay
 * while the picks are disabled with the page's explanation. The server side
 * is test/integration/gallery.spec.ts.
 */

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

/** 4 tops x 2 bottoms x 2 shoes: 16 ideas, three pages of 6. */
async function closet(page: Page): Promise<void> {
  const garments: [string, string, string][] = [
    ['White tee', 'tops', 'white'],
    ['Grey tee', 'tops', 'grey'],
    ['Black tee', 'tops', 'black'],
    ['Beige tee', 'tops', 'beige'],
    ['Raw jeans', 'bottoms', 'blue'],
    ['Khaki chinos', 'bottoms', 'beige'],
    ['White sneakers', 'footwear', 'white'],
    ['Brown boots', 'footwear', 'brown'],
  ];
  for (const [name, category, color] of garments) {
    await createGarment(page, name, category, { color });
  }
}

test('swipes through ideas with native scroll snapping and loads the next page', async ({
  page,
  browserName,
}) => {
  await signIn(page, 'gallery-swipe');
  await closet(page);
  await page.goto('/outfits/ideas');
  const strip = page.locator('#idea-strip');
  const cards = strip.locator('article[data-idea]');
  await expect(cards).toHaveCount(6);
  await expect(strip).toHaveCSS('scroll-snap-type', 'x mandatory');
  await expect(cards.first()).toHaveCSS('scroll-snap-align', 'center');
  // One idea fills the strip at phone width.
  const stripBox = (await strip.boundingBox())!;
  const cardBox = (await cards.first().boundingBox())!;
  expect(Math.abs(cardBox.width - stripBox.width)).toBeLessThan(2);

  // A swipe is a horizontal scroll; it comes to rest on a card, not between.
  await strip.hover();
  await page.mouse.wheel(stripBox.width * 0.7, 0);
  await expect
    .poll(() =>
      strip.evaluate((el: HTMLElement) => {
        const offsets = [...el.querySelectorAll('article')].map(
          (card) => card.offsetLeft - el.offsetLeft,
        );
        return offsets.some(
          (left) => left > 0 && Math.abs(left - el.scrollLeft) < 2,
        );
      }),
    )
    .toBe(true);

  // Scrolling to the end reveals the sentinel: the next pages arrive.
  for (const expected of [12, 16]) {
    await strip.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
    await expect(cards).toHaveCount(expected);
  }
  await expect(strip.locator('[data-ideas-more]')).toHaveCount(0);

  // Nothing listens for touches on the strip: the swipe is the browser's.
  if (browserName === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: "document.getElementById('idea-strip')",
    });
    const { listeners } = await cdp.send('DOMDebugger.getEventListeners', {
      objectId: result.objectId!,
      depth: -1,
    });
    expect(listeners.filter((l) => /^(touch|pointer)/.test(l.type))).toEqual(
      [],
    );
  }
});

test('a pick from the calendar plan page plans the idea on that day', async ({
  page,
}) => {
  await signIn(page, 'gallery-plan');
  await closet(page);
  const day = householdToday();
  await page.goto(`/calendar/plan?for=day:${day}&occasion=evening`);
  await page.getByRole('link', { name: 'Choose from ideas' }).click();
  await expect(page).toHaveURL(/\/outfits\/ideas\?for=day:/);
  await page
    .getByRole('button', { name: /^Plan for / })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`/calendar\\?week=${day}$`));
  await expect(page.getByText('Evening').first()).toBeVisible();
});

test('offline, the cards stay and the picks are disabled with the reason', async ({
  page,
  context,
}) => {
  await signIn(page, 'gallery-offline');
  await closet(page);
  await page.goto('/outfits/ideas');
  const pick = page.getByRole('button', { name: 'Save this outfit' }).first();
  const note = page.locator('[data-offline-note]');
  await expect(pick).toBeEnabled();
  await expect(note).toBeHidden();

  await context.setOffline(true);
  await expect(page.locator('#connectivity-banner')).toBeVisible();
  await expect(pick).toBeDisabled();
  await expect(note).toBeVisible();
  await expect(page.locator('article[data-idea]')).toHaveCount(6);

  await context.setOffline(false);
  await expect(pick).toBeEnabled();
  await expect(note).toBeHidden();
});

test('a double tap on a pick posts once (every PostForm submits once)', async ({
  page,
}) => {
  await signIn(page, 'gallery-double');
  await closet(page);
  await page.goto('/outfits/ideas');
  // A slow network: the first post is still in flight when the second tap
  // lands, which is when a browser sends it again (a double click within
  // one task is coalesced by the browser itself, so it proves nothing).
  const posts: string[] = [];
  await page.route('**/outfits/ideas/pick', async (route) => {
    posts.push(route.request().method());
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.continue();
  });
  const save = page.getByRole('button', { name: 'Save this outfit' }).first();
  await save.scrollIntoViewIfNeeded();
  // Two taps on the same spot, 150 ms apart, as a thumb does.
  const box = (await save.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.click(x, y);
  await page.waitForTimeout(150);
  await page.mouse.click(x, y);
  await expect(page).toHaveURL(/\/outfits\/\d+$/);
  expect(posts).toEqual(['POST']);
  // Back to the gallery (the back/forward cache): its buttons work again.
  await page.goBack();
  await expect(
    page.getByRole('button', { name: 'Save this outfit' }).first(),
  ).toBeEnabled();
});
