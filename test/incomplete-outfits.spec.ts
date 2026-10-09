import { expect, type Page, test, type TestInfo } from '@playwright/test';
import { and, eq, inArray } from 'drizzle-orm';
import { garment } from '../src/db/schema';
import { addDays } from '../src/calendar-date';
import { createOutfit } from '../src/web/outfits/queries';
import { signInAs } from './support/e2e-session';
import { householdToday } from './support/household-today';
import { pageErrors } from './support/page-errors';
import { seedDemoAs } from './support/seed-demo';
import { seedMuseInbox } from './support/seed-muse';
import { userIdOf, withServerDb } from './support/server-db';

/**
 * An incomplete outfit in a browser (#335 PR 1; the rule:
 * src/web/outfits/references.ts): the demo persona's closet with one of
 * Muse's picks, the navy blazer, saved into an outfit with the persona's
 * own trousers, shirt and shoes. Its collage badges the blazer To buy, the
 * Saved grid says "1 piece to buy", the outfit page offers the blazer in
 * place of Plan (Edit in Styling kept), and the calendar's picker shows it
 * disabled, its text at full strength: at 390 and
 * 1440 px, with the screenshots the owner reviews attached to each test
 * (`incomplete-<screen>-<width>.png`). What each surface refuses is
 * test/integration/incomplete-outfits.spec.ts's.
 */

const PHONE_DEVICE = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
};
const DESKTOP_DEVICE = { viewport: { width: 1440, height: 900 } };

let email: string;
let outfitId: number;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  email = await seedDemoAs('incomplete');
  const { options } = await seedMuseInbox(email);
  const blazer = options[0][0];
  outfitId = await withServerDb(async (db) => {
    const ownerId = await userIdOf(db, email);
    const closet = await db
      .select({ id: garment.id, category: garment.category })
      .from(garment)
      .where(
        and(
          eq(garment.ownerId, ownerId),
          eq(garment.status, 'closet'),
          inArray(garment.category, ['tops', 'bottoms', 'footwear']),
        ),
      )
      .orderBy(garment.id);
    const first = (category: string) => {
      const found = closet.find((g) => g.category === category);
      if (!found) throw new Error(`The demo closet has no ${category}`);
      return { category, garmentId: found.id };
    };
    const saved = await createOutfit(db, ownerId, {
      name: 'Office, with the blazer',
      slots: [
        { category: 'outerwear', garmentId: blazer },
        first('tops'),
        first('bottoms'),
        first('footwear'),
      ],
    });
    return saved.id;
  });
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
  const path = testInfo.outputPath(`incomplete-${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(`incomplete-${name}.png`, {
    path,
    contentType: 'image/png',
  });
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
  const { width } = device.viewport;
  test.describe(`at ${label} px`, () => {
    test.skip(
      ({ browserName }) => browserName === 'firefox' && 'isMobile' in device,
      'Firefox cannot emulate a phone (isMobile): the phone shots are Chromium’s and WebKit’s',
    );
    test.use(device);

    test('the Saved grid: the tile says what it waits for, the blazer badged', async ({
      page,
    }, testInfo) => {
      const errors = pageErrors(page);
      await signInAs(page, email);
      await page.goto('/outfits');
      const tile = page.locator(`[data-outfit-id="${outfitId}"]`);
      await expect(tile).toContainText('1 piece to buy');
      await expect(tile.locator('[data-mark="to-buy"]')).toHaveCount(1);
      await noSideScroll(page, width);
      await shoot(page, testInfo, `saved-${label}`);
      expect(errors).toEqual([]);
    });

    test('the outfit page: the piece to buy in place of Plan, one tap to it', async ({
      page,
    }, testInfo) => {
      const errors = pageErrors(page);
      await signInAs(page, email);
      await page.goto(`/outfits/${outfitId}`);
      await expect(page.getByText('To wear this, buy')).toBeVisible();
      await expect(page.locator('[data-outfit-plan]')).toHaveCount(0);
      await expect(page.locator('[data-outfit-edit]')).toBeVisible();
      const piece = page.locator('[data-piece-to-buy]');
      await expect(piece).toContainText('Navy unstructured wool blazer');
      const box = await piece.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      await noSideScroll(page, width);
      await shoot(page, testInfo, `outfit-${label}`);
      await piece.click();
      await expect(page).toHaveURL(/\/wardrobe\/\d+/);
      await expect(
        page.getByRole('button', { name: 'This one' }),
      ).toBeVisible();
      expect(errors).toEqual([]);
    });

    test('the calendar’s picker: the outfit disabled, saying to buy it first', async ({
      page,
    }, testInfo) => {
      const errors = pageErrors(page);
      await signInAs(page, email);
      const day = addDays(householdToday(), 2);
      await page.goto(`/calendar/plan?for=day:${day}&occasion=all-day`);
      const button = page.locator(
        `button[name="outfitId"][value="${outfitId}"]`,
      );
      await expect(button).toBeDisabled();
      await expect(button).toContainText('Buy 1 piece first');
      // Disabled reads through the card and its thumbs; text is never dimmed.
      expect(await button.evaluate((b) => getComputedStyle(b).opacity)).toBe(
        '1',
      );
      await button.scrollIntoViewIfNeeded();
      await noSideScroll(page, width);
      await shoot(page, testInfo, `picker-${label}`);
      expect(errors).toEqual([]);
    });
  });
}
