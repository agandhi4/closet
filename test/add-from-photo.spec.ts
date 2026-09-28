import { expect, type Page, test } from '@playwright/test';
import sharp from 'sharp';
import { signIn } from './support/e2e-session';

/**
 * Adding a garment from a photo (#97) at phone width, in both themes: the
 * Wardrobe's ＋ opens the add sheet, the camera row opens the camera
 * (`capture=environment`) or the library row the picker, the chosen photo
 * is prepared on the phone and posted, the new garment form opens with it,
 * and saving lands on the garment with its cutout under way (the test
 * server's stub model answers in 3 s).
 */

test.use({ viewport: { width: 390, height: 844 } });

async function openAddSheet(page: Page) {
  await page.goto('/wardrobe');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const sheet = page.locator('#add-sheet');
  await expect(sheet).toBeVisible();
  return sheet;
}

const photo = () =>
  sharp({
    create: { width: 900, height: 1200, channels: 3, background: '#357' },
  })
    .jpeg()
    .toBuffer();

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('the camera row takes a photo, the form opens with it, and saving lands on the garment with its cutout under way', async ({
      page,
    }) => {
      await signIn(page, `add-photo-${colorScheme}`);
      const sheet = await openAddSheet(page);

      const camera = sheet.locator('[data-photo-source="camera"]');
      await expect(camera).toBeVisible();
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        camera.click(),
      ]);
      expect(await chooser.element().getAttribute('capture')).toBe(
        'environment',
      );
      expect(chooser.isMultiple()).toBe(false);
      await chooser.setFiles({
        name: 'IMG_0001.jpg',
        mimeType: 'image/jpeg',
        buffer: await photo(),
      });

      await expect(page).toHaveURL(/\/wardrobe\/new\?photo=[0-9a-f-]+\.webp$/);
      const preview = page.locator('#link-photo img');
      await expect(preview).toBeVisible();
      await expect(preview).toHaveJSProperty('complete', true);
      expect(
        await preview.evaluate((img: HTMLImageElement) => img.naturalWidth),
      ).toBeGreaterThan(0);
      await expect(
        page.getByText('The background is removed once you save.'),
      ).toBeVisible();
      // Nothing is wider than the phone.
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(390);

      await page.locator('input[name="name"]').fill('Camera shirt');
      await page.locator('#garment-category').fill('shirt');
      await page.getByRole('button', { name: 'Save', exact: true }).click();

      await expect(page).toHaveURL(/\/wardrobe\/\d+(\?created=1)?$/);
      await expect(page.getByText('Camera shirt').first()).toBeVisible();
      await expect(page.locator('#garment-photo-status')).toHaveText(
        /Removing background/,
      );
      await expect(page.locator('#garment-photo img')).toHaveAttribute(
        'src',
        /^\/file\/nobg\/[0-9a-f-]+\.webp\?v=2&k=[0-9a-f]{12}&s=[\w-]{16}$/,
        { timeout: 15_000 },
      );

      // The grid shows the new garment once, with its photo.
      await page.goto('/wardrobe');
      await expect(
        page.locator('#wardrobe-grid').getByText('Camera shirt'),
      ).toHaveCount(1);
    });

    test('the library row picks a photo without the camera', async ({
      page,
    }) => {
      await signIn(page, `add-library-${colorScheme}`);
      const sheet = await openAddSheet(page);

      const library = sheet.locator('[data-photo-source="library"]');
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        library.click(),
      ]);
      expect(await chooser.element().getAttribute('capture')).toBeNull();
      await chooser.setFiles({
        name: 'from-library.jpg',
        mimeType: 'image/jpeg',
        buffer: await photo(),
      });
      await expect(page).toHaveURL(/\/wardrobe\/new\?photo=[0-9a-f-]+\.webp$/);
      await expect(page.locator('#link-photo img')).toBeVisible();
    });
  });
}
