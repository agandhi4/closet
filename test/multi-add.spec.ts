import { expect, type Page, test } from '@playwright/test';
import sharp from 'sharp';
import { signIn } from './support/e2e-session';

/**
 * Adding several garments from photos at once (#200) at phone width: the
 * add sheet's library takes several photos, each is prepared on the phone
 * and posted in one upload, the queue steps through a draft per photo
 * (category first, Skip coming back round), and the last save lands in
 * select mode with the batch checked, which "Set…" tags together. The
 * server side is test/integration/draft-batch.spec.ts.
 */

test.use({ viewport: { width: 390, height: 844 } });

const COLOURS = ['#357', '#a33', '#3a5', '#cc3'];

const photo = (background: string) =>
  sharp({ create: { width: 900, height: 1200, channels: 3, background } })
    .jpeg()
    .toBuffer();

const draftPhoto = (page: Page) =>
  new URL(page.url()).searchParams.get('photo');

async function saveDraft(page: Page, category: string, name: string) {
  await page.locator('#garment-category').fill(category);
  await page.locator('input[name="name"]').fill(name);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
}

test('four photos from the library become four drafts, saved one by one into select mode', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await signIn(page, 'multi-add');

  await page.goto('/wardrobe');
  await page.getByRole('button', { name: 'Add' }).click();
  const sheet = page.locator('#add-sheet');
  await expect(sheet).toBeVisible();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    sheet.locator('[data-photo-source="library"]').click(),
  ]);
  expect(chooser.isMultiple()).toBe(true);
  await chooser.setFiles(
    await Promise.all(
      COLOURS.map(async (colour, index) => ({
        name: `IMG_000${index + 1}.jpg`,
        mimeType: 'image/jpeg',
        buffer: await photo(colour),
      })),
    ),
  );

  // The first draft: the queue, every photo's thumb, category before name.
  await expect(page).toHaveURL(/\/wardrobe\/new\?photo=[0-9a-f-]+\.webp/);
  const queue = page.locator('#draft-queue');
  await expect(queue.getByRole('heading')).toHaveText('4 photos to add');
  await expect(queue.getByRole('listitem')).toHaveCount(4);
  await expect(queue.locator('[aria-current="step"]')).toHaveCount(1);
  const category = await page.locator('#garment-category').boundingBox();
  const name = await page.locator('input[name="name"]').boundingBox();
  expect(category!.y).toBeLessThan(name!.y);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({ path: test.info().outputPath('first-draft.png') });

  const first = draftPhoto(page);
  await saveDraft(page, 'tops', 'Multi one');

  // The second: skip it for now.
  await expect(queue.getByRole('heading')).toHaveText('3 photos to add');
  const skipped = draftPhoto(page);
  expect(skipped).not.toBe(first);
  await queue.getByRole('link', { name: 'Skip for now' }).click();
  await expect(page).not.toHaveURL(new RegExp(`photo=${skipped}`));

  await saveDraft(page, 'tops', 'Multi three');
  await expect(queue.getByRole('heading')).toHaveText('2 photos to add');
  await saveDraft(page, 'tops', 'Multi four');

  // The skipped one comes back round, last.
  await expect(queue.getByRole('heading')).toHaveText('Last photo to add');
  expect(draftPhoto(page)).toBe(skipped);
  await expect(queue.getByRole('link', { name: 'Skip for now' })).toHaveCount(
    0,
  );
  await saveDraft(page, 'tops', 'Multi two');

  // Select mode, the batch checked: Set… tags all four.
  await expect(
    page.getByRole('heading', { level: 1, name: 'Select garments' }),
  ).toBeVisible();
  await expect(
    page.getByText('4 garments added and selected.', { exact: false }),
  ).toBeVisible();
  await expect(page.locator('#selected-count')).toHaveText('4');
  await expect(page).not.toHaveURL(/checked=/);
  for (const garment of [
    'Multi one',
    'Multi two',
    'Multi three',
    'Multi four',
  ]) {
    await expect(page.getByRole('checkbox', { name: garment })).toBeChecked();
  }
  await page.screenshot({ path: test.info().outputPath('select-mode.png') });
  await page.getByRole('button', { name: 'Set…' }).click();
  const dialog = page.locator('#bulk-dialog');
  await dialog.getByRole('tab', { name: 'Warmth' }).check();
  await dialog.getByRole('radio', { name: 'Warm', exact: true }).check();
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('Set on 4 garments')).toBeVisible();

  await page.goto('/wardrobe?warmth=4');
  await expect(page.locator('#wardrobe-grid > a')).toHaveCount(4);
  expect(errors).toEqual([]);
});
