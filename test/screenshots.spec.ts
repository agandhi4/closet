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

test('demo: Theo, several outfits a day', async ({ page }) => {
  await signInAs(page, 'demo');
  // Thursday Aug 13: a morning run, the office, then rooftop drinks.
  await page.goto('/calendar?week=2026-08-09');
  await expect(page.locator('[data-occasion="night-out"]')).not.toHaveCount(0);
  await shot(page, '25-demo-calendar-three-outfits');
  // Planning one more on the planned Saturday (gym, the day, a date).
  await shot(
    page,
    '26-demo-calendar-plan',
    '/calendar/plan?for=day:2026-10-03&occasion=night-out',
  );
});

test('demo: Theo, the wishlist', async ({ page }) => {
  await signInAs(page, 'demo');
  await shot(page, '30-demo-wishlist', '/wardrobe/wishlist');
  await page.getByRole('link', { name: 'New grey merino crewneck' }).click();
  await expect(page.locator('#garment-replacement')).toBeVisible();
  await shot(page, '31-demo-wishlist-item');
  await page.getByRole('link', { name: 'Bought it' }).first().click();
  await expect(
    page.getByRole('button', { name: 'Move to closet' }),
  ).toBeVisible();
  await shot(page, '32-demo-bought-it');
  // The pilling merino it replaces: "Find a replacement", and the item.
  await page.goto('/wardrobe?keyword=Grey%20merino');
  await page
    .locator('#wardrobe-grid')
    .getByRole('heading', { name: 'Grey merino crewneck', exact: true })
    .click();
  await expect(
    page.getByRole('link', { name: 'Find a replacement' }),
  ).toBeVisible();
  await shot(page, '33-demo-replace-soon');
});

test('demo: Theo, weather', async ({ page }) => {
  await signInAs(page, 'demo');
  // Today's line (the seed's simulated weather, from the test server's
  // stand-in for Open-Meteo) in °F, then the forecast on this week's days.
  await page.goto('/wardrobe');
  await expect(page.locator('p#weather-line')).toContainText('°F');
  await shot(page, '35-demo-weather-wardrobe');
  await page.goto('/calendar');
  await expect(page.locator('[data-weather-day]')).not.toHaveCount(0);
  await shot(page, '36-demo-weather-calendar');
  await page.goto('/auth/profile');
  await expect(page.locator('#weather')).toContainText(
    'Home: Fort Greene, Brooklyn',
  );
  await page.locator('#weather').scrollIntoViewIfNeeded();
  await shot(page, '37-demo-weather-profile');
});

test('demo: Theo, his plan and style profile', async ({ page }) => {
  await signInAs(page, 'demo');
  await shot(page, '38-demo-plans', '/wardrobe/plans');
  await page.getByRole('link', { name: 'NYC minimal' }).click();
  await expect(page.locator('#plan-missing')).toBeVisible();
  await shot(page, '39-demo-plan-gaps');
  await shot(page, '40-demo-style-profile', '/auth/profile/style');
  // The shopping list (#34b): the two gaps with W01 and W02, within budget.
  await page.goto('/wardrobe/shopping');
  await expect(page.locator('#shopping-list')).toContainText(
    'New grey merino crewneck',
  );
  await shot(page, '42-demo-shopping-list');
  await page.getByRole('link', { name: 'Bought it' }).first().click();
  await expect(page.locator('#bought-plans')).toBeVisible();
  await shot(page, '43-demo-bought-for-plan');
  await shot(page, '44-demo-compare-one-plan', '/wardrobe/plans/compare');
});

test('demo: Theo, the outfit gallery', async ({ page }) => {
  await signInAs(page, 'demo');
  // A fixed seed, so the run's cards are the same ideas whatever the day's
  // seed would be (the weather still follows the test server's today).
  await page.goto('/outfits/ideas?seed=1');
  await expect(page.locator('article[data-idea]').first()).toBeVisible();
  await shot(page, '46-demo-ideas');
  // From the planned week's "+ Plan": Tuesday evening.
  await page.goto('/calendar/plan?for=day:2026-09-29&occasion=evening');
  await page.getByRole('link', { name: 'Choose from ideas' }).click();
  await expect(
    page.getByRole('button', { name: 'Plan for Tuesday' }).first(),
  ).toBeVisible();
  await shot(page, '47-demo-ideas-for-day');
  // "Style this" on the olive chinos: every idea holds them, never with the
  // olive chore coat (his Clashes), whose page lists the pair.
  await page.goto('/wardrobe?keyword=Olive%20chinos');
  await page
    .locator('#wardrobe-grid')
    .getByRole('heading', { name: 'Olive chinos', exact: true })
    .click();
  await expect(page.locator('#garment-avoided')).toContainText(
    'Olive chore coat',
  );
  await page.getByRole('link', { name: 'Style this' }).click();
  await expect(page.getByText('With Olive chinos')).toBeVisible();
  await shot(page, '48-demo-style-this');
});

test('sparse: Dana, untagged and degraded', async ({ page }) => {
  await signInAs(page, 'sparse');
  await shot(page, '12-sparse-wardrobe', '/wardrobe');
  await shot(page, '13-sparse-tagging', '/wardrobe/tag');
});

test('fresh: Riley, the empty states', async ({ page }) => {
  await signInAs(page, 'fresh');
  await shot(page, '14-fresh-wardrobe', '/wardrobe');
  // No city yet: the header's weather line asks for one.
  await expect(page.getByText('Add your city for the weather')).toBeVisible();
  await shot(page, '15-fresh-outfits', '/outfits');
  await shot(page, '16-fresh-calendar', `/calendar?week=${ANCHOR}`);
  await shot(page, '24-fresh-laundry', '/laundry');
  await shot(page, '34-fresh-wishlist', '/wardrobe/wishlist');
  await shot(page, '41-fresh-plans', '/wardrobe/plans');
  await shot(page, '45-fresh-shopping-list', '/wardrobe/shopping');
  await shot(page, '49-fresh-ideas', '/outfits/ideas');
  await shot(
    page,
    '27-fresh-calendar-plan',
    `/calendar/plan?for=day:${ANCHOR}`,
  );
});
