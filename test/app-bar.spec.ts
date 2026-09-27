import { expect, type Page, test } from '@playwright/test';
import { createCapsule, createGarment, createOutfit } from './support/e2e-data';
import { signIn } from './support/e2e-session';

/**
 * The app bar at phone width (src/web/layout/app-bar.tsx, #82): every
 * section's pages carry it with their own title, it fits the phone, nothing
 * the page scrolls under it draws over it, it never meets the dock, the
 * avatar opens Profile, and an htmx navigation swaps it with the page. In
 * both schemes: the bar is drawn from the theme's tokens.
 */

test.use({ viewport: { width: 390, height: 844 } });

const bar = (page: Page) => page.locator('header.app-bar');

/** The page's title: the bar's h1, the only one. */
async function expectTitle(page: Page, title: string | RegExp, where: string) {
  await expect(page.locator('h1'), where).toHaveCount(1);
  await expect(bar(page).locator('h1'), where).toHaveText(title);
}

/**
 * The bar's geometry against the page's: at the top, as wide as the
 * screen, nothing inside it wider than it (a long title truncates rather
 * than pushing the avatar off), and clear of the dock.
 */
async function expectBarFits(page: Page, where: string): Promise<void> {
  const layout = await page.evaluate(() => {
    const header = document.querySelector('header.app-bar')!;
    const box = header.getBoundingClientRect();
    const dock = document.querySelector('.dock')?.getBoundingClientRect();
    const avatar = header
      .querySelector('#avatar, a[href^="/auth/"]')
      ?.getBoundingClientRect();
    return {
      top: box.top,
      width: box.width,
      overflows: header.scrollWidth > header.clientWidth,
      avatarRight: avatar?.right,
      barBottom: box.bottom,
      dockTop: dock?.top,
    };
  });
  expect(layout.top, where).toBe(0);
  expect(layout.width, where).toBe(390);
  expect(layout.overflows, `${where}: nothing wider than the bar`).toBe(false);
  expect(
    layout.avatarRight,
    `${where}: the avatar on screen`,
  ).toBeLessThanOrEqual(390);
  if (layout.dockTop !== undefined) {
    expect(layout.barBottom, `${where}: above the dock`).toBeLessThan(
      layout.dockTop,
    );
  }
}

/**
 * Probes the bar every 16 px across its middle: whatever the page stacks at
 * those points must be the bar itself. Answers the points that hit
 * something else, named.
 */
async function pointsOverTheBar(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const header = document.querySelector('header.app-bar')!;
    const box = header.getBoundingClientRect();
    const blocked: string[] = [];
    const y = box.top + box.height / 2;
    for (let x = box.left + 4; x < box.right; x += 16) {
      const hit = document.elementFromPoint(x, y);
      if (hit && header.contains(hit)) continue;
      const name = hit
        ? `${hit.tagName.toLowerCase()}.${[...hit.classList].join('.')}`
        : 'nothing';
      blocked.push(`(${Math.round(x)}, ${Math.round(y)}): ${name}`);
    }
    return blocked;
  });
}

/** Scrolls so the first `selector` element sits under the bar's middle. */
async function scrollUnderTheBar(page: Page, selector: string): Promise<void> {
  const scrolled = await page.evaluate((sel) => {
    const header = document
      .querySelector('header.app-bar')!
      .getBoundingClientRect();
    const barMiddle = header.top + header.height / 2;
    const element = document.querySelector(sel);
    if (!element) return false;
    const box = element.getBoundingClientRect();
    const middle = box.top + window.scrollY + box.height / 2;
    window.scrollTo({ top: middle - barMiddle, behavior: 'instant' });
    return window.scrollY > 0;
  }, selector);
  expect(scrolled, `${selector} scrolled under the bar`).toBe(true);
}

test('every section carries the bar with its own title, fitting the phone', async ({
  page,
}) => {
  await signIn(page, 'app-bar-pages');
  const garment = await createGarment(
    page,
    'A tee with a name long enough to need truncating in the bar',
  );
  const outfit = await createOutfit(page, 'Bar outfit', garment);
  const capsule = await createCapsule(page, 'Bar capsule');

  const pages: [path: string, title: string | RegExp][] = [
    ['/', /\w/],
    ['/wardrobe', 'Wardrobe'],
    [`/wardrobe/${garment}`, /^A tee with a name long enough/],
    ['/capsules', 'Wardrobe'],
    [`/capsules/${capsule}`, 'Bar capsule'],
    ['/wardrobe/plans', 'Plans'],
    ['/styling', 'Styling'],
    ['/outfits', 'Outfits'],
    ['/outfits/ideas', 'Outfits'],
    [`/outfits/${outfit}`, 'Bar outfit'],
    ['/calendar', 'Calendar'],
    ['/trips', 'Calendar'],
    ['/auth/profile', 'Profile'],
    ['/auth/profile/style', 'Style profile'],
    ['/auth/tokens', 'Agent Access'],
  ];
  for (const [path, title] of pages) {
    await page.goto(path);
    await expectTitle(page, title, path);
    await expect(bar(page).locator('#avatar'), path).toBeVisible();
    await expectBarFits(page, path);
  }
});

test('nothing scrolled under the bar draws over it', async ({ page }) => {
  await signIn(page, 'app-bar-overlap');
  // Three tiles a row (R3's grid): six rows, so the grid scrolls.
  const garments: number[] = [];
  for (let i = 1; i <= 18; i++) {
    garments.push(await createGarment(page, `Under tee ${i}`));
  }
  for (let i = 0; i < 6; i++) {
    await createOutfit(page, `Under outfit ${i + 1}`, garments[i]);
  }

  // The positioned content that could reach the bar: the outfit card's
  // calendar button (relative z-10), the grid's tiles, select mode's
  // checkboxes (absolute z-10), Profile's sections.
  const pages: [path: string, content: string][] = [
    ['/outfits', '[data-outfit-id]:nth-of-type(3) .dropdown'],
    ['/wardrobe', '#wardrobe-grid > a:nth-of-type(6)'],
    [
      '/wardrobe?select=1',
      '#wardrobe-grid input[type="checkbox"]:nth-of-type(1)',
    ],
    ['/auth/profile', '#week'],
  ];
  for (const [path, content] of pages) {
    await page.goto(path);
    expect(await pointsOverTheBar(page), `${path}, at the top`).toEqual([]);
    await scrollUnderTheBar(page, content);
    expect(
      await pointsOverTheBar(page),
      `${path}, ${content} under the bar`,
    ).toEqual([]);
  }
});

test('the avatar opens Profile in place, and back returns', async ({
  page,
}) => {
  await signIn(page, 'app-bar-avatar');
  await page.goto('/wardrobe');
  await page.evaluate(() => {
    (window as Window & { __sameDocument?: boolean }).__sameDocument = true;
  });

  await bar(page).locator('#avatar').click();
  await expect(page).toHaveURL(/\/auth\/profile$/);
  await expectTitle(page, 'Profile', 'Profile, swapped in');
  await expect(bar(page).locator('#avatar')).toHaveAttribute(
    'aria-current',
    'page',
  );
  // A boosted navigation: the body swapped, the document kept.
  expect(
    await page.evaluate(
      () => (window as Window & { __sameDocument?: boolean }).__sameDocument,
    ),
  ).toBe(true);
  // No tab is Profile's: the avatar marks it instead.
  await expect(page.locator('.dock a[aria-current="page"]')).toHaveCount(0);

  // A section's page goes back to its section.
  await page.locator('#style').getByRole('link').click();
  await expectTitle(page, 'Style profile', 'the style profile');
  await bar(page).getByRole('link', { name: 'Back' }).click();
  await expect(page).toHaveURL(/\/auth\/profile#style$/);
  await expect(page.locator('#style')).toBeInViewport();

  // Back through htmx's history restore (Profile at #style, the style
  // profile, Profile, then the wardrobe): the wardrobe's bar again.
  await page.goBack();
  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL(/\/wardrobe$/);
  await expectTitle(page, 'Wardrobe', 'the wardrobe, restored');
  await expect(bar(page).locator('#avatar')).not.toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('the old sharing page lands on Profile › Sharing', async ({ page }) => {
  await signIn(page, 'app-bar-sharing');
  await page.goto('/wardrobe-share/manage');
  await expect(page).toHaveURL(/\/auth\/profile#sharing$/);
  await expect(page.locator('#sharing')).toBeInViewport();
  // The invite form still swaps its link in place.
  await page
    .locator('#sharing')
    .getByRole('button', { name: 'Create Invite Link' })
    .click();
  await expect(page.locator('#invite-link-result input')).toHaveValue(
    /\/wardrobe-share\/invite\//,
  );
});

/** An oklch() colour's lightness, 0 to 1, as Chromium computes the theme's. */
function lightness(colour: string): number {
  const match = /^oklch\(([\d.]+)(%?)/.exec(colour);
  if (!match) throw new Error(`Not an oklch() colour: ${colour}`);
  return Number(match[1]) / (match[2] ? 100 : 1);
}

test.describe('dark', () => {
  test.use({ colorScheme: 'dark' });

  test("the bar takes the dark theme's page colour", async ({ page }) => {
    await signIn(page, 'app-bar-dark');
    for (const path of ['/wardrobe', '/auth/profile']) {
      await page.goto(path);
      // daisyUI paints the page (base-100) on the root element.
      const colours = await page.evaluate(() => ({
        bar: getComputedStyle(document.querySelector('header.app-bar')!)
          .backgroundColor,
        page: getComputedStyle(document.documentElement).backgroundColor,
        title: getComputedStyle(document.querySelector('header.app-bar h1')!)
          .color,
      }));
      expect(colours.bar, path).toBe(colours.page);
      // closet-dark's warm charcoal, and its paper-coloured ink.
      expect(lightness(colours.bar), `${path}: a dark bar`).toBeLessThan(0.5);
      expect(lightness(colours.title), `${path}: light text`).toBeGreaterThan(
        0.5,
      );
      await expectBarFits(page, `${path}, dark`);
    }
  });
});
