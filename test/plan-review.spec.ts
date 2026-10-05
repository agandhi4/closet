import { expect, type Page, test } from '@playwright/test';
import { eq } from 'drizzle-orm';
import {
  planItem,
  planItemCandidate,
  planItemRejection,
} from '../src/db/schema';
import { createGarment } from './support/e2e-data';
import { SAME_ORIGIN, signIn } from './support/e2e-session';
import { pageErrors } from './support/page-errors';
import { withServerDb } from './support/server-db';

/**
 * The plan review in a browser at phone width (#271): an agent's proposals
 * as strips, a swipe to another candidate, "Accept these", and the gap view
 * with the choices made (the pick kept, the unpicked candidate gone from
 * the wishlist); and (#278) Change this with a note and Not this one with
 * a reason, kept through the swipes into the one post. The rules and the
 * data-safety cases are test/integration/plan-review.spec.ts's and
 * plan-item-review.spec.ts's.
 */

test.use({ viewport: { width: 390, height: 844 } });

async function post(page: Page, url: string, form: Record<string, string>) {
  const res = await page.request.post(url, { form, headers: SAME_ORIGIN });
  expect(res.ok()).toBe(true);
  return new URL(res.url()).pathname;
}

test('review an agent’s proposals as strips, swipe to a candidate, accept', async ({
  page,
}) => {
  const errors = pageErrors(page);
  await signIn(page, 'plan-review');
  const plan = await post(page, '/wardrobe/plans', { name: 'Muse’s draft' });
  const items: Record<string, string>[] = [
    {
      name: 'Black boots',
      category: 'footwear',
      colors: 'black',
      budget: '200',
    },
    { name: 'Camel coat', category: 'outerwear' },
  ];
  for (const item of items) {
    await post(page, `${plan}/items`, {
      quantity: '1',
      priority: 'medium',
      ...item,
    });
  }
  const wishlist = { to: 'wishlist', wishlist: '1', props: '1', product: '1' };
  const cheap = await createGarment(page, 'Cheap black boots', 'footwear', {
    ...wishlist,
    color: 'black',
    price: '150',
  });
  const navy = await createGarment(page, 'Navy boots', 'footwear', {
    ...wishlist,
    color: 'blue',
    price: '180',
  });
  // What the agent did over MCP: proposed both items (propose_plan_item).
  const planId = Number(plan.split('/').pop());
  const [boots, coat] = await withServerDb(async (db) => {
    const rows = await db
      .update(planItem)
      .set({ review: 'proposed' })
      .where(eq(planItem.planId, planId))
      .returning({ id: planItem.id, name: planItem.name });
    const id = (name: string) => rows.find((row) => row.name === name)!.id;
    return [id('Black boots'), id('Camel coat')];
  });
  for (const garmentId of [cheap, navy]) {
    await post(page, `${plan}/items/${boots}/candidates`, {
      garmentIds: String(garmentId),
    });
  }

  await page.goto(plan);
  await page.locator('#plan-review').click();
  await expect(page).toHaveURL(`${plan}/review`);
  await expect(page.locator('h1')).toHaveText('Review Muse’s draft');
  // Top to toe: the coat (a layer) before the boots.
  await expect(page.locator('section[id^="review-item-"]')).toHaveCount(2);
  await expect(page.locator('section[id^="review-item-"]').first()).toHaveId(
    `review-item-${coat}`,
  );
  const coatPick = page.locator(`#review-item-${coat} input[name="pick"]`);
  const bootsStrip = page.locator(`#review-item-${boots} [data-snap-strip]`);
  const bootsPick = page.locator(`#review-item-${boots} input[name="pick"]`);
  await expect(coatPick).toHaveValue(`${coat}:keep`);
  // The matching candidate within budget is first, and where the strip starts.
  await expect(bootsPick).toHaveValue(`${boots}:${cheap}`);
  await expect(
    bootsStrip.locator(`[data-snap-value="${boots}:${cheap}"]`),
  ).toContainText('Within budget');

  // A swipe is the strip's own scrolling: wheel it one item on, and the
  // navy pair (it doesn't match) is centred and chosen.
  await bootsStrip.scrollIntoViewIfNeeded();
  const box = (await bootsStrip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(box.width / 3, 0);
  await expect(bootsPick).toHaveValue(`${boots}:${navy}`);
  const navyTile = bootsStrip.locator(`[data-snap-value="${boots}:${navy}"]`);
  await expect(navyTile).toHaveAttribute('data-selected', '');
  await expect(
    navyTile.getByText('Doesn’t match the item: blue vs black'),
  ).toBeVisible();
  // The centred tile's outfit count loads once seen in the strip.
  await expect(navyTile.locator('[data-goes-with-count]')).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);

  // The removal is opted into: the box starts unticked.
  const removeUnpicked = page.getByLabel(
    'Remove the products I didn’t pick from my wishlist',
  );
  await expect(removeUnpicked).not.toBeChecked();
  await removeUnpicked.check();
  await page.getByRole('button', { name: 'Accept these' }).click();

  await expect(page).toHaveURL(plan);
  await expect(page.locator('#plan-toast')).toContainText(
    'Review saved. 1 product removed from your wishlist',
  );
  await expect(page.locator('#plan-review')).toHaveCount(0);
  const bootsCard = page.locator(`#plan-item-${boots}`);
  await expect(bootsCard).toHaveAttribute('data-status', 'missing');
  // Its options are thumbs, each named (#295), in its sheet (#312).
  await bootsCard.getByRole('button').first().click();
  await expect(
    bootsCard.getByRole('link', { name: 'Navy boots' }),
  ).toBeVisible();
  await expect(
    bootsCard.getByRole('link', { name: 'Cheap black boots' }),
  ).toHaveCount(0);
  await expect(page.locator(`#plan-item-${coat}`)).toHaveAttribute(
    'data-status',
    'missing',
  );
  // The unpicked candidate stood for nothing else: off the wishlist.
  const gone = await page.request.get(`/wardrobe/${cheap}`);
  expect(gone.status()).toBe(404);
  expect(errors).toEqual([]);
});

test('Change this with a note, and Not this one on a candidate, in one post', async ({
  page,
}) => {
  const errors = pageErrors(page);
  await signIn(page, 'plan-review-iterate');
  const plan = await post(page, '/wardrobe/plans', { name: 'Muse’s second' });
  const items: Record<string, string>[] = [
    { name: 'Black boots', category: 'footwear', colors: 'black' },
    { name: 'Camel coat', category: 'outerwear' },
  ];
  for (const item of items) {
    await post(page, `${plan}/items`, {
      quantity: '1',
      priority: 'medium',
      ...item,
    });
  }
  const wishlist = { to: 'wishlist', wishlist: '1', props: '1', product: '1' };
  const shiny = await createGarment(page, 'Shiny black boots', 'footwear', {
    ...wishlist,
    color: 'black',
    price: '120',
  });
  const matte = await createGarment(page, 'Matte black boots', 'footwear', {
    ...wishlist,
    color: 'black',
    price: '160',
  });
  const planId = Number(plan.split('/').pop());
  const [boots, coat] = await withServerDb(async (db) => {
    const rows = await db
      .update(planItem)
      .set({ review: 'proposed' })
      .where(eq(planItem.planId, planId))
      .returning({ id: planItem.id, name: planItem.name });
    const id = (name: string) => rows.find((row) => row.name === name)!.id;
    return [id('Black boots'), id('Camel coat')];
  });
  for (const garmentId of [shiny, matte]) {
    await post(page, `${plan}/items/${boots}/candidates`, {
      garmentIds: String(garmentId),
    });
  }

  await page.goto(`${plan}/review`);
  /** Scrolls a strip `items` tiles on (negative: back), as a swipe does. */
  const swipe = async (itemId: number, items: number) => {
    const strip = page.locator(`#review-item-${itemId} [data-snap-strip]`);
    await strip.scrollIntoViewIfNeeded();
    const box = (await strip.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel((items * box.width) / 3, 0);
  };

  // The coat goes back to the agent: Change this…, with what to change.
  const coatPick = page.locator(`#review-item-${coat} input[name="pick"]`);
  await expect(coatPick).toHaveValue(`${coat}:keep`);
  await swipe(coat, -1);
  await expect(coatPick).toHaveValue(`${coat}:change`);
  // A non-product tile centred: the products' reserved details are dropped,
  // so the note sits right under the tiles (#284).
  const coatStrip = page.locator(`#review-item-${coat} [data-snap-strip]`);
  const coatNote = page.locator(`#review-note-${coat}`);
  const stripBox = (await coatStrip.boundingBox())!;
  const noteBox = (await coatNote.boundingBox())!;
  expect(noteBox.y - (stripBox.y + stripBox.height)).toBeLessThan(60);
  await coatNote.fill('Wool, and longer');

  // The boots: the cheaper pair starts centred; turn that very pair down with
  // a reason, without swiping away. A rejected pick reads as Keep.
  const bootsPick = page.locator(`#review-item-${boots} input[name="pick"]`);
  await expect(bootsPick).toHaveValue(`${boots}:${shiny}`);
  const shinyTile = page.locator(
    `#review-item-${boots} [data-snap-value="${boots}:${shiny}"]`,
  );
  // A tap as a finger does: the box brought to the middle of the screen
  // (clear of the dock) without scrolling the strip, then its middle
  // clicked. locator.check() scrolls the strip onto a neighbour
  // (test/CLAUDE.md, scroll-snap strips).
  const notThisOne = shinyTile.getByLabel('Not this one');
  await notThisOne.evaluate((box) =>
    box.scrollIntoView({ block: 'center', inline: 'nearest' }),
  );
  const tick = (await notThisOne.boundingBox())!;
  await page.mouse.click(tick.x + tick.width / 2, tick.y + tick.height / 2);
  await expect(notThisOne).toBeChecked();
  await expect(bootsPick).toHaveValue(`${boots}:${shiny}`);
  const reason = shinyTile.getByRole('textbox', {
    name: 'Why not Shiny black boots',
  });
  await expect(reason).toHaveAttribute('placeholder', 'Why not?');
  // The placeholder fits the field.
  expect(await reason.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await reason.fill('Too shiny');
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);

  await page.getByRole('button', { name: 'Accept these' }).click();
  await expect(page).toHaveURL(plan);
  await expect(page.locator('#plan-toast')).toContainText(
    'Review saved. 1 product removed from your wishlist',
  );
  const coatCard = page.locator(`#plan-item-${coat}`);
  await expect(coatCard).toHaveAttribute('data-status', 'revise');
  await expect(coatCard).toContainText('Your note: Wool, and longer');
  const bootsCard = page.locator(`#plan-item-${boots}`);
  await expect(bootsCard).toHaveAttribute('data-status', 'missing');
  await bootsCard.getByRole('button').first().click();
  await expect(
    bootsCard.getByRole('link', { name: 'Matte black boots' }),
  ).toBeVisible();
  // The rejected pair stood for nothing else: off the wishlist, its reason kept.
  expect((await page.request.get(`/wardrobe/${shiny}`)).status()).toBe(404);
  const rejected = await withServerDb((db) =>
    db
      .select({
        name: planItemRejection.name,
        reason: planItemRejection.reason,
      })
      .from(planItemRejection)
      .where(eq(planItemRejection.planItemId, boots)),
  );
  expect(rejected).toEqual([
    { name: 'Shiny black boots', reason: 'Too shiny' },
  ]);
  expect(errors).toEqual([]);
});

test('the agent’s longest note fits its tile at phone width, and the strip opens on its pick (#293)', async ({
  page,
}) => {
  const errors = pageErrors(page);
  await signIn(page, 'candidate-notes');
  const plan = await post(page, '/wardrobe/plans', { name: 'Notes' });
  await post(page, `${plan}/items`, {
    quantity: '1',
    priority: 'medium',
    name: 'White sneakers',
    category: 'footwear',
  });
  const planId = Number(plan.split('/').pop());
  const wishlist = { to: 'wishlist', wishlist: '1', props: '1', product: '1' };
  // The cheaper one is older: without a rank the strip would open on it.
  const cheap = await createGarment(page, 'Cheap sneakers', 'footwear', {
    ...wishlist,
    price: '40',
  });
  const pick = await createGarment(page, 'Leather sneakers', 'footwear', {
    ...wishlist,
    price: '140',
  });
  // The longest note the tools take, ending in a word no space breaks: the
  // worst case for a 7 rem tile.
  const note =
    `${'Full-grain leather, half a size big. '.repeat(5)}https://shop.example/white-sneakers-leather-court`
      .slice(0, 240)
      .trim();
  const item = await withServerDb(async (db) => {
    const [row] = await db
      .update(planItem)
      .set({ review: 'proposed' })
      .where(eq(planItem.planId, planId))
      .returning({ id: planItem.id });
    return row.id;
  });
  for (const garmentId of [cheap, pick]) {
    await post(page, `${plan}/items/${item}/candidates`, {
      garmentIds: String(garmentId),
    });
  }
  await withServerDb((db) =>
    db
      .update(planItemCandidate)
      .set({ note, rank: 1 })
      .where(eq(planItemCandidate.garmentId, pick)),
  );

  await page.goto(`${plan}/review`);
  const strip = page.locator(`#review-item-${item} [data-snap-strip]`);
  await expect(
    page.locator(`#review-item-${item} input[name="pick"]`),
  ).toHaveValue(`${item}:${pick}`);
  const tile = strip.locator(`[data-snap-value="${item}:${pick}"]`);
  await expect(tile).toHaveAttribute('data-selected', '');
  await expect(tile.locator('[data-agents-pick]')).toHaveText('Agent’s pick');
  const text = tile.locator('[data-candidate-note]');
  await expect(text).toHaveText(note);
  // Not clipped: the note wraps inside the tile, which neither scrolls nor
  // cuts it, and the page does not grow sideways.
  const fit = await text.evaluate((el) => {
    const tileBox = el.closest('[data-snap-item]')!.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return {
      scrolls: el.scrollWidth > el.clientWidth,
      inside: box.left >= tileBox.left - 1 && box.right <= tileBox.right + 1,
      overflow: getComputedStyle(el).overflow,
      page: document.documentElement.scrollWidth,
    };
  });
  expect(fit).toEqual({
    scrolls: false,
    inside: true,
    overflow: 'visible',
    page: 390,
  });
  expect(errors).toEqual([]);
});
