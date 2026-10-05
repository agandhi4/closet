import { expect, type Page, test, type TestInfo } from '@playwright/test';
import { signInAs } from './support/e2e-session';
import { pageErrors } from './support/page-errors';
import { seedDemoAs } from './support/seed-demo';
import { type MuseSeed, seedMuseInbox } from './support/seed-muse';

/**
 * Muse's inbox in a browser (#333 PR B; docs/plans/2026-10-05-muse-suggestions.md,
 * section 4 D, C, F), on the demo persona's closet with a Muse round
 * seeded through the app's writers and the seed's generated art: what only
 * a browser shows. The options strip at 390 px and the side-by-side
 * columns at 1440, Not for me opening in place, a reason chip's one tap,
 * the photo viewer, New from Muse arriving after load, a decision disabled
 * offline, and the screenshots the owner reviews before merge: attached to
 * each test (`muse-<screen>-<width>.png`), so the HTML report keeps them,
 * CI's uploaded one included. The rows each decision writes are
 * test/integration/muse-inbox.spec.ts's.
 */

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

/**
 * The phone as a phone: a touch screen, so the page's `fine` variant (the
 * snap strip's step buttons, a mouse's) is off as on a real one.
 */
const PHONE_DEVICE = { viewport: PHONE, hasTouch: true, isMobile: true };
const DESKTOP_DEVICE = { viewport: DESKTOP };

let seed: MuseSeed;
let email: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  email = await seedDemoAs('muse');
  seed = await seedMuseInbox(email);
});

async function shoot(page: Page, testInfo: TestInfo, name: string) {
  // Lazy images below the fold load before the shot.
  await page.evaluate(async () => {
    for (const img of document.querySelectorAll('img')) {
      img.loading = 'eager';
    }
    await Promise.all(
      [...document.images]
        .filter((img) => !img.complete)
        .map((img) => img.decode().catch(() => undefined)),
    );
  });
  // The page's whole height as the viewport, not `fullPage`: Chromium's
  // full-page capture drops the touch emulation for the shot, so the
  // phone would be drawn with a mouse's controls (the strip's steps). The
  // fixed dock lands at the foot, over the page's own bottom padding.
  const viewport = page.viewportSize()!;
  const height = await page.evaluate(
    () => document.documentElement.scrollHeight,
  );
  await page.setViewportSize({ width: viewport.width, height });
  const path = testInfo.outputPath(`muse-${name}.png`);
  await page.screenshot({ path });
  await page.setViewportSize(viewport);
  await testInfo.attach(`muse-${name}.png`, { path, contentType: 'image/png' });
}

function noSideScroll(page: Page, width: number) {
  return expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(width);
}

for (const [label, device] of [
  ['390', PHONE_DEVICE],
  ['1440', DESKTOP_DEVICE],
] as const) {
  const { viewport } = device;
  test.describe(`at ${label} px`, () => {
    test.skip(
      ({ browserName }) => browserName === 'firefox' && 'isMobile' in device,
      'Firefox cannot emulate a phone (isMobile): the phone shots are Chromium’s and WebKit’s',
    );
    test.use(device);

    test('the inbox: Ready to buy, Muse’s picks, your wishlist, still looking, set aside', async ({
      page,
    }, testInfo) => {
      const errors = pageErrors(page);
      await signInAs(page, email);
      await page.goto('/wardrobe/wishlist');
      const sections = page.locator('[data-inbox-section]');
      await expect(sections).toHaveCount(5);
      await expect(page.locator('[data-inbox-section="ready"]')).toContainText(
        'Olive waxed field jacket',
      );
      const blazer = page.locator(`[data-need="${seed.needs[0]}"]`);
      await expect(blazer).toContainText('A navy unstructured blazer');
      await expect(
        blazer.locator('[data-unlocks], [data-unlocks-each]').first(),
      ).toBeVisible();
      await expect(
        page.locator('[data-inbox-section="still-looking"]'),
      ).toContainText('A light rain shell');
      await expect(page.getByText('2 set aside')).toBeVisible();
      await noSideScroll(page, viewport.width);
      await shoot(page, testInfo, `inbox-${label}`);
      expect(errors).toEqual([]);
    });

    test('a need’s decision screen: the options, This one, Not for me in place', async ({
      page,
    }, testInfo) => {
      const errors = pageErrors(page);
      await signInAs(page, email);
      await page.goto(`/wardrobe/wishlist/needs/${seed.needs[0]}`);
      const options = page.locator('[data-need-options] [data-option]');
      await expect(options).toHaveCount(2);
      await expect(
        page.getByRole('button', { name: 'This one' }).first(),
      ).toBeVisible();
      await expect(page.locator('[data-best-outfits]').first()).toBeVisible();
      if (viewport.width >= 1024) {
        // Side by side: both cards in view at once, nothing to step through.
        const [first, second] = await Promise.all(
          [0, 1].map((n) => options.nth(n).boundingBox()),
        );
        expect(first!.y).toBe(second!.y);
        expect(second!.x).toBeGreaterThan(first!.x + first!.width - 1);
        await expect(page.locator('[data-snap-step]').first()).toBeHidden();
      } else {
        // A phone: one card centred, the next peeking, and no step buttons
        // over it (a touch screen swipes).
        const width = (await options.first().boundingBox())!.width;
        expect(width).toBeLessThan(viewport.width * 0.9);
        await expect(page.locator('[data-snap-step]').first()).toBeHidden();
      }
      await noSideScroll(page, viewport.width);
      await shoot(page, testInfo, `decision-${label}`);
      expect(errors).toEqual([]);
    });

    test('a pick’s own page: From Muse, its need, This one, the other options', async ({
      page,
    }, testInfo) => {
      const errors = pageErrors(page);
      await signInAs(page, email);
      await page.goto(`/wardrobe/${seed.options[0][0]}`);
      const section = page.locator('[data-suggestion-state="open"]');
      await expect(section).toContainText('From Muse');
      await expect(section.locator('[data-need-link]')).toContainText(
        'A navy unstructured blazer',
      );
      await expect(
        section.getByRole('button', { name: 'This one' }),
      ).toBeVisible();
      await expect(section.locator('[data-other-options]')).toBeVisible();
      await expect(page.locator('#goes-with')).toBeVisible();
      await noSideScroll(page, viewport.width);
      await shoot(page, testInfo, `pick-${label}`);
      expect(errors).toEqual([]);
    });
  });
}

test.describe('in a browser at 390 px', () => {
  test.use({ viewport: PHONE });

  test('New from Muse arrives after load, never in the page itself', async ({
    page,
  }) => {
    await signInAs(page, email);
    const seen = page.waitForResponse(
      (res) =>
        res.url().endsWith('/wardrobe/wishlist/seen') &&
        res.request().method() === 'POST',
    );
    const res = await page.goto('/wardrobe/wishlist');
    expect(await res!.text()).not.toContain('data-new-from-muse');
    await seen;
  });

  test('a photo opens the viewer; Not for me opens in place and one reason sets the pick aside', async ({
    page,
  }) => {
    const errors = pageErrors(page);
    await signInAs(page, email);
    const need = seed.needs[2];
    const [first] = seed.options[2];
    await page.goto(`/wardrobe/wishlist/needs/${need}?option=${first}`);
    const card = page.locator(`[data-option="${first}"]`);

    await card.locator('[data-photo-open]').click();
    await expect(page.locator('#photo-viewer')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#photo-viewer')).toBeHidden();

    await card.getByText('Not for me').click();
    const chip = card.getByRole('button', { name: 'The colour' });
    await expect(chip).toBeVisible();
    await card.getByLabel('A note for Muse (optional)').fill('Too light');
    await chip.click();
    // Back on the need (its toast's flag already dropped from the address).
    await expect(page.locator('#decision-toast')).toBeVisible();
    await expect(page).toHaveURL(
      new RegExp(`/wardrobe/wishlist/needs/${need}$`),
    );
    await expect(
      page.locator(`[data-need-options] [data-option="${first}"]`),
    ).toHaveCount(0);
    // Undo, from the set-aside list in place.
    await page.locator('[data-need-set-aside] summary').click();
    await page
      .locator(`[data-set-aside="pick:${first}"]`)
      .getByRole('button', { name: /Undo/ })
      .click();
    await expect(
      page.locator(`[data-need-options] [data-option="${first}"]`),
    ).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test('offline, This one is disabled, and comes back with the network', async ({
    page,
    context,
  }) => {
    await signInAs(page, email);
    await page.goto(`/wardrobe/wishlist/needs/${seed.needs[1]}`);
    const choose = page.getByRole('button', { name: 'This one' }).first();
    await expect(choose).toBeEnabled();
    await context.setOffline(true);
    await expect(page.locator('#connectivity-banner')).toBeVisible();
    await expect(choose).toBeDisabled();
    await context.setOffline(false);
    await expect(choose).toBeEnabled();
  });
});
