import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { signUpHeaders } from './support/e2e-session';

/**
 * Phone-width (390 px) screenshots of the key pages with the seed personas
 * (CLAUDE.md, Seed personas), saved to screenshots/ for CI to upload as a
 * PR artifact: how every change looks with real data. Not a visual gate:
 * people look at them. Runs only with SEED_SCREENSHOTS (CI's e2e job), as
 * it writes the personas into whatever database the server uses.
 *
 * The seed runs here rather than as a CI step: the CLI refuses a database
 * the build has not migrated, and the server Playwright starts is what
 * migrates it. A fixed anchor makes every run's history the same, and the
 * calendar is addressed by week, whatever today is.
 */

const PASSWORD = 'Closet-demo-1';
const ANCHOR = '2026-09-26';
const DIR = 'screenshots';

test.skip(!process.env.SEED_SCREENSHOTS, 'SEED_SCREENSHOTS is not set');
test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

test.beforeAll(() => {
  mkdirSync(DIR, { recursive: true });
  // Idempotent: a retry finds the personas seeded and leaves them.
  execFileSync(
    'node',
    [
      'dist/seed/seed.cli.js',
      '--persona',
      'all',
      '--anchor',
      ANCHOR,
      '--password-stdin',
    ],
    { input: `${PASSWORD}\n`, stdio: ['pipe', 'inherit', 'inherit'] },
  );
});

async function signInAs(page: Page, persona: string): Promise<void> {
  const res = await page.request.post('/auth/login', {
    form: { email: `${persona}@closet.invalid`, password: PASSWORD },
    headers: signUpHeaders(),
    maxRedirects: 0,
  });
  expect(res.status()).toBe(302);
}

async function shot(page: Page, name: string, url?: string): Promise<void> {
  if (url) await page.goto(url);
  await page.waitForLoadState('networkidle');
  await page.screenshot({
    path: `${DIR}/${name}.png`,
    fullPage: true,
    animations: 'disabled',
  });
}

test('demo: Theo, every feature with real data', async ({ page }) => {
  await signInAs(page, 'demo');
  await shot(page, '01-demo-wardrobe', '/wardrobe');
  await expect(page.locator('#wardrobe-grid a')).not.toHaveCount(0);
  await page
    .locator('#filter-modal')
    .evaluate((d: HTMLDialogElement) => d.showModal());
  await shot(page, '02-demo-filters');
  await page.goto('/wardrobe?keyword=raw');
  await page.locator('#wardrobe-grid a').first().click();
  await expect(page.getByText('Raw selvedge jeans').first()).toBeVisible();
  await shot(page, '03-demo-garment');
  await page.goto(`${page.url().split('?')[0]}/edit`);
  await page
    .locator('details.collapse')
    .first()
    .evaluate((d: HTMLDetailsElement) => (d.open = true));
  await shot(page, '04-demo-garment-form');
  // Adding from a link as Android's share sheet opens it. Only the link
  // page: the prefilled form needs a fetch from the internet, which CI's
  // shots must not depend on (link-import.spec.ts covers the form).
  await shot(
    page,
    '04b-demo-link-import',
    `/wardrobe/new/from-link?text=${encodeURIComponent(
      'UB201 Tapered https://theunbrandedbrand.com/products/ub201-tapered-fit-indigo-selvedge',
    )}`,
  );
  await shot(page, '05-demo-select', '/wardrobe?select=1');
  await shot(page, '06-demo-outfits', '/outfits');
  await page
    .locator('a[href^="/outfits/"]:not([href="/outfits/new"])')
    .first()
    .click();
  await shot(page, '07-demo-outfit');
  await shot(page, '08-demo-outfit-builder', '/outfits/new');
  await shot(page, '09-demo-calendar-history', '/calendar?week=2026-08-23');
  await shot(page, '10-demo-calendar-planned', '/calendar?week=2026-09-27');
  await shot(page, '11-demo-shares', '/wardrobe-share/manage');
});

test('demo: Theo, capsules', async ({ page }) => {
  await signInAs(page, 'demo');
  await shot(page, '17-demo-capsules', '/capsules');
  await page.getByRole('link', { name: /^Weekend/ }).click();
  await expect(page.getByRole('heading', { name: 'Weekend' })).toBeVisible();
  await shot(page, '18-demo-capsule');
  await page.getByRole('link', { name: 'Choose garments' }).first().click();
  await expect(page.locator('#pick-form')).toBeVisible();
  await shot(page, '19-demo-capsule-picker');
});

test('demo: Theo, wears and washes', async ({ page }) => {
  await signInAs(page, 'demo');
  // Saturday night's hamper: the week's wears since Sunday's laundry.
  await shot(page, '20-demo-laundry', '/laundry');
  await expect(page.getByText('Needs a wash').first()).toBeVisible();
  // The x3 white tees: worn this week (a search also finds shirts whose
  // notes mention a white tee, so the tile is picked by its name).
  await page.goto('/wardrobe?keyword=White%20tee');
  await page
    .locator('#wardrobe-grid')
    .getByRole('heading', { name: 'White tee', exact: true })
    .click();
  await expect(page.locator('#garment-wear')).toContainText('Worn');
  await shot(page, '21-demo-garment-wears');
  await shot(page, '22-demo-needs-wash', '/wardrobe?needsWash=true');
  await shot(page, '23-demo-needs-attention', '/wardrobe?attention=true');
});

test('sparse: Dana, untagged and degraded', async ({ page }) => {
  await signInAs(page, 'sparse');
  await shot(page, '12-sparse-wardrobe', '/wardrobe');
  await shot(page, '13-sparse-tagging', '/wardrobe/tag');
});

test('fresh: Riley, the empty states', async ({ page }) => {
  await signInAs(page, 'fresh');
  await shot(page, '14-fresh-wardrobe', '/wardrobe');
  await shot(page, '15-fresh-outfits', '/outfits');
  await shot(page, '16-fresh-calendar', `/calendar?week=${ANCHOR}`);
  await shot(page, '24-fresh-laundry', '/laundry');
});
