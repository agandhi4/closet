import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { SAME_ORIGIN, signIn } from './support/e2e-session';
import { householdToday } from './support/household-today';

/**
 * Profile › Export (#200) at phone width: both downloads are 44 px or more
 * to tap while the rest of Profile keeps its small buttons, and a tap
 * downloads the file (not boosted, not the service worker's). The export's
 * contents are test/integration/wardrobe-export.spec.ts's.
 */

test.use({ viewport: { width: 390, height: 844 } });

test('the export buttons are full-size touch targets and download the wardrobe', async ({
  page,
}) => {
  await signIn(page, 'export-buttons');
  const res = await page.request.post('/wardrobe', {
    form: { name: 'Exported tee', category: 'tops' },
    headers: SAME_ORIGIN,
  });
  expect(res.ok()).toBe(true);

  await page.goto('/auth/profile#export');
  for (const format of ['csv', 'json']) {
    const button = page.locator(`[data-export="${format}"]`);
    await expect(button).toBeVisible();
    const box = (await button.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
  // Only these two: another Profile button keeps daisyUI's small size.
  const style = await page
    .getByRole('link', { name: 'Edit your style profile' })
    .boundingBox();
  expect(style!.height).toBeLessThan(44);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-export="csv"]').click(),
  ]);
  expect(download.suggestedFilename()).toBe(`closet-${householdToday()}.csv`);
  const path = await download.path();
  expect(await readFile(path, 'utf8')).toContain('Exported tee');
});
