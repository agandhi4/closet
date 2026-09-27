import { expect, type Page, test } from '@playwright/test';
import { createCapsule, createGarment, createOutfit } from './support/e2e-data';
import { signIn } from './support/e2e-session';

/**
 * The dock at phone width (src/web/layout/dock.tsx): nothing on a page draws
 * over it, and it marks the section of every page (layout/sections.ts), on a
 * full load and after an htmx navigation. Found by the redesign plan's 390 px
 * screenshots (docs/plans/2026-09-26-redesign.md): the outfit card's
 * calendar button drew over the dock, and only a tab root lit its tab.
 */

test.use({ viewport: { width: 390, height: 844 } });

/** A Sunday to Saturday week the overlap test fills with calendar chips. */
const WEEK = ['20', '21', '22', '23', '24', '25', '26'].map(
  (day) => `2026-09-${day}`,
);

const activeTab = (page: Page) => page.locator('.dock a[aria-current="page"]');

async function expectActiveTab(
  page: Page,
  href: string | null,
  where: string,
): Promise<void> {
  if (href === null) {
    await expect(activeTab(page), where).toHaveCount(0);
    await expect(page.locator('.dock .dock-active'), where).toHaveCount(0);
    return;
  }
  await expect(activeTab(page), where).toHaveAttribute('href', href);
  await expect(activeTab(page), where).toHaveClass(/\bdock-active\b/);
  await expect(page.locator('.dock .dock-active'), where).toHaveCount(1);
}

async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as Window & { __sameDocument?: boolean }).__sameDocument = true;
  });
}

async function expectSameDocument(page: Page, where: string): Promise<void> {
  expect(
    await page.evaluate(
      () => (window as Window & { __sameDocument?: boolean }).__sameDocument,
    ),
    `${where}: an htmx swap, not a document load`,
  ).toBe(true);
}

/**
 * Taps a boosted link to `href`, as every link in the app is (the body's
 * hx-boost): htmx swaps the body with the server's page for that URL and
 * pushes it. The link is added to the page so any route can be reached
 * from anywhere; htmx.process boosts it like one rendered by the server.
 */
async function boostedTap(page: Page, href: string): Promise<void> {
  await page.evaluate((target) => {
    const link = document.createElement('a');
    link.id = 'dock-spec-link';
    link.href = target;
    link.textContent = 'Go';
    document.querySelector('main')!.prepend(link);
    // The page's global (layout.tsx loads htmx as a classic script); the
    // specs have no htmx types.
    const { htmx } = window as unknown as {
      htmx: { process(elt: Element): void };
    };
    htmx.process(link);
  }, href);
  await page.locator('#dock-spec-link').click();
  await expect(page).toHaveURL(href);
  await expect(page.locator('#dock-spec-link')).toHaveCount(0);
}

test('every page marks its section in the dock, loaded or swapped in', async ({
  page,
}) => {
  await signIn(page, 'dock-active');
  const garment = await createGarment(page, 'Dock tee');
  const outfit = await createOutfit(page, 'Dock outfit', garment);
  const capsule = await createCapsule(page, 'Dock capsule');

  const routes: [path: string, tab: string | null][] = [
    ['/wardrobe', '/wardrobe'],
    ['/wardrobe?category=tops', '/wardrobe'],
    [`/wardrobe/${garment}`, '/wardrobe'],
    [`/wardrobe/${garment}/edit`, '/wardrobe'],
    ['/wardrobe/new', '/wardrobe'],
    ['/capsules', '/wardrobe'],
    [`/capsules/${capsule}`, '/wardrobe'],
    ['/styling', '/styling'],
    [`/styling?capsule=${capsule}`, '/styling'],
    [`/styling?outfit=${outfit}`, '/styling'],
    ['/outfits', '/outfits'],
    [`/outfits/${outfit}`, '/outfits'],
    ['/calendar', '/calendar'],
    [`/calendar?week=${WEEK[0]}`, '/calendar'],
    ['/auth/profile', null],
    ['/auth/profile/style', null],
  ];

  for (const [path, tab] of routes) {
    await page.goto(path);
    await expectActiveTab(page, tab, `${path}, loaded`);

    // Swapped in from a page whose tab differs, so a dock the swap did not
    // replace would show the wrong one.
    const from = tab === null ? '/calendar' : '/auth/profile';
    await page.goto(from);
    await markDocument(page);
    await boostedTap(page, path);
    await expectSameDocument(page, path);
    await expectActiveTab(page, tab, `${path}, after an htmx navigation`);

    // Back is htmx's history restore (its snapshot of the body).
    await page.goBack();
    await expect(page).toHaveURL(from);
    await expectActiveTab(
      page,
      tab === null ? '/calendar' : null,
      `${from}, restored from ${path}`,
    );
  }
});

/**
 * Probes across the dock's middle and upper band, every 16 px: whatever the
 * page stacks at those points must be the dock itself. Answers the points
 * that hit something else, named, so a failure says what drew over it.
 */
async function pointsOverTheDock(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const dock = document.querySelector('.dock')!;
    const box = dock.getBoundingClientRect();
    const blocked: string[] = [];
    for (const y of [box.top + 6, box.top + box.height / 2]) {
      for (let x = box.left + 4; x < box.right; x += 16) {
        const hit = document.elementFromPoint(x, y);
        if (hit && dock.contains(hit)) continue;
        const name = hit
          ? `${hit.tagName.toLowerCase()}.${[...hit.classList].join('.')}`
          : 'nothing';
        blocked.push(`(${Math.round(x)}, ${Math.round(y)}): ${name}`);
      }
    }
    return blocked;
  });
}

async function expectDockOnTop(page: Page, where: string): Promise<void> {
  expect(await pointsOverTheDock(page), where).toEqual([]);
}

/**
 * Scrolls the first `selector` element that starts below the fold to the
 * dock's middle, where content scrolls under the dock, and checks the dock
 * still covers it. The page must hold enough content to reach it.
 */
async function scrollUnderTheDock(page: Page, selector: string): Promise<void> {
  const scrolled = await page.evaluate((sel) => {
    const dock = document.querySelector('.dock')!.getBoundingClientRect();
    const dockMiddle = dock.top + dock.height / 2;
    for (const element of document.querySelectorAll(sel)) {
      const box = element.getBoundingClientRect();
      const middle = box.top + window.scrollY + box.height / 2;
      if (middle < dockMiddle) continue;
      window.scrollTo({ top: middle - dockMiddle, behavior: 'instant' });
      return true;
    }
    return false;
  }, selector);
  expect(
    scrolled,
    `a ${selector} below the fold to scroll under the dock`,
  ).toBe(true);
}

async function scrollToBottom(page: Page): Promise<void> {
  await page.evaluate(() =>
    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: 'instant',
    }),
  );
}

test('nothing on a page draws over the dock', async ({ page }) => {
  await signIn(page, 'dock-overlap');
  // Three tiles a row (R3's grid): six rows run the grid past the fold.
  const garments: number[] = [];
  for (let i = 1; i <= 18; i++) {
    garments.push(await createGarment(page, `Stack tee ${i}`));
  }
  // One outfit a day of WEEK (a chip, with its delete form, per day) and a
  // few more, so the outfit list and the week both run past the fold.
  for (let i = 0; i < 10; i++) {
    await createOutfit(
      page,
      `Stack outfit ${i + 1}`,
      garments[i],
      WEEK[i] ?? '',
    );
  }
  const capsule = await createCapsule(page, 'Stack capsule');

  // Each page with the positioned content that can reach the dock: the
  // outfit card's calendar button (relative z-10), the calendar chip's
  // delete form (relative z-10), select mode's and the capsule picker's
  // checkboxes (absolute z-10) under their bar above the dock, the grid
  // under the search and filter bar, the garment page's controls.
  const pages: [path: string, content: string][] = [
    ['/outfits', '[data-outfit-id] .dropdown'],
    [`/calendar?week=${WEEK[0]}`, 'form[hx-confirm]'],
    ['/wardrobe', '#wardrobe-grid > a'],
    ['/wardrobe?select=1', '#wardrobe-grid input[type="checkbox"]'],
    [`/wardrobe?pick=${capsule}`, '#wardrobe-grid input[type="checkbox"]'],
    [`/wardrobe/${garments[0]}`, 'main :is(a, button, form, input)'],
  ];

  for (const [path, content] of pages) {
    await page.goto(path);
    await expectDockOnTop(page, `${path}, at the top`);
    await scrollUnderTheDock(page, content);
    await expectDockOnTop(page, `${path}, ${content} under the dock`);
    await scrollToBottom(page);
    await expectDockOnTop(page, `${path}, scrolled to the bottom`);
  }

  // A card's calendar button just above the dock, its dropdown opened: the
  // dropdown reaches down over the dock and stays under it.
  await page.goto('/outfits');
  const opened = await page.evaluate(() => {
    const dockTop = document
      .querySelector('.dock')!
      .getBoundingClientRect().top;
    const labels = document.querySelectorAll<HTMLElement>(
      '[data-outfit-id] .dropdown > label',
    );
    for (const label of labels) {
      const bottom = label.getBoundingClientRect().bottom + window.scrollY;
      if (bottom < dockTop) continue;
      window.scrollTo({ top: bottom - dockTop + 8, behavior: 'instant' });
      label.focus();
      return true;
    }
    return false;
  });
  expect(opened, 'a calendar button below the fold').toBe(true);
  await expect(
    page.locator('.dropdown:focus-within .dropdown-content'),
  ).toBeVisible();
  await expectDockOnTop(page, '/outfits, a calendar dropdown open over it');

  // Toasts stand above the dock, never on it. An inline module, as the
  // pages import toast.js: through the importmap (layout.tsx).
  await page.addScriptTag({
    type: 'module',
    content:
      "import { showToast } from 'toast'; showToast({ text: 'A toast above the dock' });",
  });
  const toast = page.getByText('A toast above the dock');
  await expect(toast).toBeVisible();
  const [toastBottom, dockTop] = await Promise.all([
    toast.evaluate((element) => element.getBoundingClientRect().bottom),
    page.locator('.dock').evaluate((dock) => dock.getBoundingClientRect().top),
  ]);
  expect(toastBottom).toBeLessThanOrEqual(dockTop);
  await expectDockOnTop(page, '/outfits, with a toast');
});
