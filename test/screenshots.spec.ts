import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { addDays } from '../src/web/calendar/calendar-date';
import { signUpHeaders } from './support/e2e-session';
import { householdToday } from './support/household-today';
import { fakeSubscription, stubPushManager } from './support/push-stub';

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

// The dark theme (#81, closet-dark follows the system's scheme): the same
// four pages as their light twins above, named after them. Before any test
// re-seeds Theo, so each pair shows the same data.
test.describe('dark', () => {
  test.use({ colorScheme: 'dark' });

  test('demo: Theo, the key pages in the dark theme', async ({ page }) => {
    await signInAs(page, 'demo');
    await shot(page, '01-demo-wardrobe-dark', '/wardrobe');
    await page.goto('/wardrobe?keyword=raw');
    await page.locator('#wardrobe-grid a').first().click();
    await expect(page.getByText('Raw selvedge jeans').first()).toBeVisible();
    await shot(page, '03-demo-garment-dark');
    await shot(page, '08-demo-outfit-builder-dark', '/outfits/new');
    await shot(
      page,
      '10-demo-calendar-planned-dark',
      '/calendar?week=2026-09-27',
    );
  });
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
  // Saturday's hamper: the week's wears since Sunday's laundry.
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
  // "Goes with my closet" (#18b) on the Allbirds: 50+ outfits, and the
  // white sneakers he already owns.
  await page.goto('/wardrobe/wishlist');
  await page.getByRole('link', { name: 'White Couriers' }).click();
  await expect(page.locator('[data-goes-with-duplicates]')).toContainText(
    'White sneakers',
  );
  await shot(page, '34-demo-goes-with');
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

test('demo: Theo, insights', async ({ page }) => {
  await signInAs(page, 'demo');
  // Measured from the real today, not the anchor: the history ages with
  // the run's date, so the figures drift (a picture, not a gate).
  await page.goto('/wardrobe/insights');
  await expect(page.locator('#insights-worn')).toBeVisible();
  await shot(page, '50-demo-insights');
  await shot(
    page,
    '51-demo-insights-unworn-30',
    '/wardrobe/insights?unworn=30',
  );
  // "Style this" on an unworn garment opens the gallery holding it.
  await page
    .locator('#insights-unworn')
    .getByRole('link', { name: 'Style this' })
    .first()
    .click();
  await expect(page.getByText(/^With /).first()).toBeVisible();
  await shot(page, '52-demo-insights-style-this');
});

test('demo: Theo, his Austin conference (#10)', async ({ page }) => {
  await signInAs(page, 'demo');
  await shot(page, '61-demo-trips', '/trips');
  await page.getByRole('link', { name: /Austin conference/ }).click();
  // The packing list derived from the trip's outfits, partly packed.
  await expect(page.locator('#trip-packed-summary')).toContainText(
    '9 of 15 packed',
  );
  await shot(page, '62-demo-trip');
  await page.locator('[data-add-outfit]').first().click();
  await expect(
    page.getByRole('heading', { name: 'Add an outfit' }),
  ).toBeVisible();
  await shot(page, '63-demo-trip-add-outfit');
});

test('sparse: Dana, untagged and degraded', async ({ page }) => {
  await signInAs(page, 'sparse');
  await shot(page, '12-sparse-wardrobe', '/wardrobe');
  await shot(page, '13-sparse-tagging', '/wardrobe/tag');
  // A closet without a wear: the figures at zero and what to do about it.
  await shot(page, '53-sparse-insights', '/wardrobe/insights');
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
  await shot(page, '54-fresh-insights', '/wardrobe/insights');
  // Today with nothing in the closet: what ideas need.
  await shot(page, '57-fresh-today', '/');
  await shot(page, '64-fresh-trips', '/trips');
  await shot(
    page,
    '27-fresh-calendar-plan',
    `/calendar/plan?for=day:${ANCHOR}`,
  );
});

// Last: it re-seeds Theo. Today is the server's real today, so his history
// is re-drawn with today as its anchor (--reset, no --anchor), which the
// simulation leaves half lived: the morning's workout worn, the evening
// planned, ideas for the day (demo.md, step 7). What exactly is planned
// depends on the weekday.
test('demo: Theo, Today and his reminders (#15)', async ({ page }) => {
  execFileSync(
    'node',
    [
      'dist/seed/seed.cli.js',
      '--persona',
      'demo',
      '--reset',
      '--password-stdin',
    ],
    { input: `${PASSWORD}\n`, stdio: ['pipe', 'inherit', 'inherit'] },
  );
  await signInAs(page, 'demo');
  await shot(page, '55-demo-today', '/');
  await expect(page.locator('[data-today-row]').first()).toBeVisible();

  // The profile's notifications, on, with this device's reminders: the
  // headless shell has no push service or permission, so both are stubbed
  // (test/support/push-stub.ts); the server's side is real.
  await stubPushManager(page, fakeSubscription(), true, { granted: true });
  await page.goto('/auth/profile');
  const reminders = page.locator('#push-reminders');
  await expect(reminders).toBeVisible();
  await reminders
    .getByRole('checkbox', { name: "Morning: today's outfit" })
    .check();
  await expect(reminders.getByText('Saved.')).toBeVisible();
  await page.locator('push-settings').scrollIntoViewIfNeeded();
  await shot(page, '56-demo-push-settings');

  // The weekly auto-plan (#16): his week template on the Profile, and the
  // days after today that "Plan my week" filled (the seed's, demo.md step
  // 7), marked Auto on the calendar: tomorrow's week has some.
  await page.locator('#week').scrollIntoViewIfNeeded();
  await shot(page, '58-demo-week-template');
  await shot(
    page,
    '59-demo-week-planned',
    `/calendar?week=${addDays(householdToday(), 1)}`,
  );
  await expect(page.locator('[data-auto]').first()).toBeVisible();
});

test('demo: Theo, outfit selfies (#19)', async ({ page }) => {
  await signInAs(page, 'demo');
  // His evenings out of the last four weeks carry a mirror selfie: the
  // latest week that has one.
  let week = '';
  for (const start of [
    '2026-09-20',
    '2026-09-13',
    '2026-09-06',
    '2026-08-30',
  ]) {
    await page.goto(`/calendar?week=${start}`);
    if ((await page.locator('button[data-selfie]').count()) > 0) {
      week = start;
      break;
    }
  }
  expect(week).not.toBe('');
  const row = page
    .locator('[data-occasion]', { has: page.locator('button[data-selfie]') })
    .first();
  await row.scrollIntoViewIfNeeded();
  await shot(page, '58-demo-calendar-selfies');
  await row.locator('button[data-selfie]').click();
  await expect(page.locator('dialog[open] img')).toBeVisible();
  await shot(page, '59-demo-selfie');
  // The outfit's Worn strip: every day it was worn, with its looks.
  const edit = await row.locator('a[href^="/outfits/"]').getAttribute('href');
  const outfit = /^\/outfits\/(\d+)\//.exec(edit ?? '')?.[1];
  await shot(page, '60-demo-outfit-worn', `/outfits/${outfit}`);
  await expect(page.locator('[data-worn-strip] img').first()).toBeVisible();
});
