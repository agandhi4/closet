import { expect, type Page, test, type TestInfo } from '@playwright/test';
import { signInAs } from './support/e2e-session';
import { pageErrors } from './support/page-errors';
import { seedDemoAs } from './support/seed-demo';
import { type MuseSeed, seedMuseInbox } from './support/seed-muse';

/**
 * Styling's Include picks in a browser (#335 part B; docs/plans/
 * 2026-10-05-muse-suggestions.md, section 4 E), on the demo persona's
 * closet with a Muse round seeded through the app's writers: the toggle
 * turns the picks on (URL state), each strip leads with them badged "To
 * buy", a need's options side by side; a swipe chooses one and Save makes
 * an incomplete outfit. The screenshots the owner reviews are attached to
 * each test (`picks-<screen>-<width>.png`). The rules are
 * test/integration/styling-picks.spec.ts's.
 */

const PHONE_DEVICE = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
};
const DESKTOP_DEVICE = { viewport: { width: 1440, height: 900 } };

let seed: MuseSeed;
let email: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  email = await seedDemoAs('picks');
  seed = await seedMuseInbox(email);
});

async function shoot(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(async () => {
    for (const img of document.querySelectorAll('img')) img.loading = 'eager';
    await Promise.all(
      [...document.images]
        .filter((img) => !img.complete)
        .map((img) => img.decode().catch(() => undefined)),
    );
  });
  const path = testInfo.outputPath(`picks-${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(`picks-${name}.png`, {
    path,
    contentType: 'image/png',
  });
}

/** The garment ids a row's strip shows, in order. */
function stripOf(page: Page, role: string): Promise<number[]> {
  return page
    .locator(`[data-styling-row="${role}"] [data-snap-value]`)
    .evaluateAll((items) =>
      items.map((item) => Number(item.getAttribute('data-snap-value'))),
    );
}

for (const [label, device] of [
  ['390', PHONE_DEVICE],
  ['1440', DESKTOP_DEVICE],
] as const) {
  const { width } = device.viewport;
  test.describe(`at ${label} px`, () => {
    test.skip(
      ({ browserName }) => browserName === 'firefox' && 'isMobile' in device,
      'Firefox cannot emulate a phone (isMobile): the phone shots are Chromium’s and WebKit’s',
    );
    test.use(device);

    test('the toggle puts the picks on the strips, a need’s options side by side', async ({
      page,
    }, testInfo) => {
      const errors = pageErrors(page);
      await signInAs(page, email);
      await page.goto('/styling');
      const toggle = page.locator('[data-styling-picks]');
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await expect(page.locator('[data-to-buy]')).toHaveCount(0);
      // The rows as they stand, which the switch keeps (it posts them).
      const topChoice = page.locator(
        '[data-styling-row="top"] input[name="garmentId"]',
      );
      const top = await topChoice.inputValue();
      await toggle.click();
      await expect(page).toHaveURL('/styling?picks=1');
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await expect(topChoice).toHaveValue(top);
      // The capsule menu outside the rows came with them, its links on.
      await expect(
        page.locator('#styling-scope a[href*="capsule="]').first(),
      ).toHaveAttribute('href', /picks=1/);
      // The blazer need's open options, in Muse's rank, side by side.
      const [one, two] = seed.options[0];
      const layer = await stripOf(page, 'layer');
      expect(layer.indexOf(two)).toBe(layer.indexOf(one) + 1);
      await expect(
        page.locator(
          `[data-styling-row="layer"] [data-snap-value="${one}"] [data-to-buy]`,
        ),
      ).toHaveText('To buy');
      // The pick set aside as too pricey is not offered.
      expect(layer).not.toContain(seed.options[0][2]);
      // The shot shows the need's options together: the first centred on
      // the phone (the second peeking), both in view on the desktop.
      const first = page.locator(
        `[data-styling-row="layer"] [data-snap-value="${one}"]`,
      );
      await first.evaluate((item) =>
        item.scrollIntoView({ block: 'center', inline: 'center' }),
      );
      await expect(
        page.locator('[data-styling-row="layer"] input[name="garmentId"]'),
      ).toHaveValue(String(one));
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
      await shoot(page, testInfo, `styling-${label}`);
      expect(errors).toEqual([]);
    });
  });
}

test.describe('a pick saved', () => {
  test.use(PHONE_DEVICE);

  test('a swipe chooses a pick, and Save makes an incomplete outfit', async ({
    page,
  }) => {
    const errors = pageErrors(page);
    await signInAs(page, email);
    await page.goto('/styling?picks=1');
    const layer = page.locator('[data-styling-row="layer"]');
    const chosen = layer.locator('input[name="garmentId"]');
    const strip = layer.locator('[data-snap-strip]');
    await strip.scrollIntoViewIfNeeded();
    // The row opens on the closet's newest layer, the picks before it: one
    // wheel step back centres the last of them.
    const ids = await stripOf(page, 'layer');
    const opened = Number(await chosen.inputValue());
    const pick = ids[ids.indexOf(opened) - 1];
    const box = (await strip.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(-box.width / 3, 0);
    await expect(chosen).toHaveValue(String(pick));
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('[data-styling-save]').click();
    await expect(page).toHaveURL(/\/outfits\/\d+$/);
    await expect(page.getByText('To wear this, buy')).toBeVisible();
    await expect(page.locator(`[data-piece-to-buy="${pick}"]`)).toBeVisible();
    expect(errors).toEqual([]);
  });
});
