import { expect, test } from '@playwright/test';
import { SAME_ORIGIN, signIn } from './support/e2e-session';

/**
 * The wardrobe grid and the garment form in a browser: what only htmx and
 * the page's scripts can show. The server side of each request is the
 * integration tier's (test/integration/wardrobe-grid.spec.ts, colors.spec.ts).
 */

// GRID_PAGE_SIZE (src/web/wardrobe/queries.ts) and a few more.
const PAGE = 48;
const TOTAL = PAGE + 5;

test('scrolling the grid loads the next page into it', async ({ page }) => {
  test.slow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await signIn(page, 'wardrobe-grid');
  for (let i = 1; i <= TOTAL; i++) {
    const res = await page.request.post('/wardrobe', {
      form: { name: `Scroll ${i}`, category: 'tops' },
      headers: SAME_ORIGIN,
    });
    expect(res.ok(), `create garment ${i}`).toBe(true);
  }

  await page.goto('/wardrobe');
  const tiles = page.locator('#wardrobe-grid > a.card');
  await expect(tiles).toHaveCount(PAGE);
  await expect(page.getByText(`${TOTAL} results`)).toBeVisible();
  // Newest first.
  await expect(tiles.first()).toContainText(`Scroll ${TOTAL}`);

  const sentinel = page.locator('[data-wardrobe-more]');
  await expect(sentinel).toHaveCount(1);
  const nextPage = page.waitForResponse((res) =>
    res.url().includes('/wardrobe/tiles?'),
  );
  await sentinel.scrollIntoViewIfNeeded();
  expect((await nextPage).status()).toBe(200);

  await expect(tiles).toHaveCount(TOTAL);
  await expect(tiles.last()).toContainText('Scroll 1');
  // The last page has no sentinel of its own.
  await expect(sentinel).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the colour picker shows values as text, never markup', async ({
  page,
}) => {
  await signIn(page, 'color-picker');
  await page.goto('/wardrobe/new');
  await page.locator('.color-ms summary').click();
  await page.getByRole('checkbox', { name: 'red' }).check();
  await expect(page.locator('.ms-pills .ms-pill')).toHaveText(['red×']);
  await expect(page.locator('.ms-count')).toHaveText('1 selected');

  // A value the server would never render (it refuses unknown colours) still
  // cannot become markup in the picker: the script builds text nodes.
  const injected = await page.evaluate(() => {
    const options = document.querySelector('.ms-options')!;
    const label = document.createElement('label');
    label.className = 'ms-option';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.name = 'color';
    box.value = '<img src=x onerror="window.__xss=1">';
    box.checked = true;
    label.append(box);
    options.append(label);
    box.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      images: document.querySelectorAll('.ms-pills img').length,
      text: document.querySelector('.ms-pills')!.textContent,
    };
  });
  expect(injected.images).toBe(0);
  expect(injected.text).toContain('<img src=x onerror="window.__xss=1">');
  expect(await page.evaluate(() => 'xss' in window || '__xss' in window)).toBe(
    false,
  );

  // Removing a pill unchecks its box.
  await page.locator('.ms-pill', { hasText: 'red' }).locator('button').click();
  await expect(page.getByRole('checkbox', { name: 'red' })).not.toBeChecked();
});
