import { expect, type Page, test } from '@playwright/test';
import { signIn } from './support/e2e-session';
import { seedGarments } from './support/server-db';

/**
 * The dock as a left rail at lg (src/web/layout/dock.tsx, restyled in
 * views/assets/main.css) and the content-width tokens (layout/page-main.tsx):
 * one markup, so the phone's dock is as before and the desktop gets a rail.
 */

const TAB_ROOTS = ['/', '/wardrobe', '/styling', '/outfits', '/calendar'];

async function expectNoHorizontalScroll(
  page: Page,
  where: string,
): Promise<void> {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow, `${where}: horizontal scroll`).toBeLessThanOrEqual(0);
}

test.describe('at 1440 px', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('the dock is a rail beside the content, on every tab root and a garment', async ({
    page,
  }) => {
    const email = await signIn(page, 'rail');
    const [garment] = await seedGarments(
      email,
      Array.from({ length: 12 }, (_, i) => `Rail tee ${i + 1}`),
    );

    for (const path of [...TAB_ROOTS, `/wardrobe/${garment}`]) {
      await page.goto(path);
      const dock = (await page.locator('.dock').boundingBox())!;
      expect(dock.x, `${path}: the rail is at the left edge`).toBe(0);
      expect(dock.width, `${path}: the rail is slim`).toBeLessThanOrEqual(96);
      expect(dock.height, `${path}: the rail runs the full height`).toBe(900);
      const main = (await page.locator('main').boundingBox())!;
      expect(
        main.x,
        `${path}: main starts beside the rail`,
      ).toBeGreaterThanOrEqual(dock.width);
      const bar = (await page.locator('.app-bar').boundingBox())!;
      expect(bar.x, `${path}: the app bar starts beside the rail`).toBe(
        dock.width,
      );
      await expect(page.locator('.dock a')).toHaveCount(5);
      for (const width of [1024, 1440, 1920]) {
        await page.setViewportSize({ width, height: 900 });
        await expectNoHorizontalScroll(page, `${path} at ${width}`);
      }
      await page.setViewportSize({ width: 1440, height: 900 });
    }

    const wardrobeMain = (await page.goto('/wardrobe'), page.locator('main'));
    expect((await wardrobeMain.boundingBox())!.width).toBeGreaterThan(900);
    await page.goto('/outfits');
    expect(
      (await page.locator('main').boundingBox())!.width,
    ).toBeLessThanOrEqual(640);

    for (const [name, path] of [
      ['today', '/'],
      ['wardrobe', '/wardrobe'],
      ['garment', `/wardrobe/${garment}`],
    ]) {
      await page.goto(path);
      await page.screenshot({ path: `test-results/309-${name}-1440.png` });
    }
  });

  test('the rail is keyboard reachable and navigates, the current tab marked', async ({
    page,
  }) => {
    await signIn(page, 'rail-keys');
    await page.goto('/wardrobe');
    const current = page.locator('.dock a[aria-current="page"]');
    await expect(current).toHaveAttribute('href', '/wardrobe');

    const wardrobeLink = page.locator('.dock a[href="/wardrobe"]');
    await wardrobeLink.focus();
    await expect(wardrobeLink).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('.dock a[href="/styling"]')).toBeFocused();

    await page.locator('.dock a[href="/outfits"]').click();
    await expect(page).toHaveURL(/\/outfits$/);
    await expect(
      page.locator('.dock a[aria-current="page"]'),
      'the htmx swap moved the mark',
    ).toHaveAttribute('href', '/outfits');
    await expect(page.locator('.dock')).toBeVisible();
  });
});

test.describe('at 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the dock is still the bottom bar, and the page fills the phone', async ({
    page,
  }) => {
    const email = await signIn(page, 'rail-phone');
    const [garment] = await seedGarments(
      email,
      Array.from({ length: 12 }, (_, i) => `Phone tee ${i + 1}`),
    );

    for (const [name, path] of [
      ['today', '/'],
      ['wardrobe', '/wardrobe'],
      ['garment', `/wardrobe/${garment}`],
    ]) {
      await page.goto(path);
      const dock = (await page.locator('.dock').boundingBox())!;
      expect(dock.x).toBe(0);
      expect(dock.width).toBe(390);
      expect(dock.y + dock.height).toBe(844);
      const main = (await page.locator('main').boundingBox())!;
      expect(main.x).toBe(0);
      expect(main.width).toBe(390);
      await expectNoHorizontalScroll(page, `${path} at 390`);
      await page.screenshot({ path: `test-results/309-${name}-390.png` });
    }
  });
});
