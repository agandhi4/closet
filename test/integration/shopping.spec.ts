import { readdir } from 'node:fs/promises';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garment, planItem, planItemCandidate } from '../../src/db/schema';
import { changeCandidates } from '../../src/web/plans/candidates';
import { buyCandidate } from '../../src/web/plans/purchase';
import { buyGarment } from '../../src/web/wardrobe/status';
import { acceptInvite, createInvite } from '../../src/web/sharing/queries';
import { jpegPhoto, uploadPhoto } from './garments';
import { createTestApp, type TestApp, unescapeHtml, userIdOf } from './harness';
import {
  html,
  jpeg,
  type LinkSites,
  productShot,
  startLinkSites,
} from './link-sites';
import { expectFullPage } from './pages';

/**
 * The shopping loop (#34, slice 34b), through HTTP: candidate products for
 * plan items (wishlist garments, linked from the item's page, from the
 * wishlist item's "For plan item…", by the wishlist form with `planItem`,
 * and by link import), the shopping list (the active plan's gaps, their
 * candidates against the budget, totals), "Bought it" fulfilling an item
 * (the match said, a mismatch offered to fix, other candidates offered for
 * removal) and comparing two plans. Private like plans: another user's
 * item is a 404, a grantee sees and sends none of it. The pure rules are
 * src/wardrobe/shopping.spec.ts's and plans.spec.ts's; the matrix rows are
 * authorization-plans.spec.ts's.
 */
describe('the shopping loop', () => {
  let t: TestApp;
  let sites: LinkSites;
  let ownerId: number;
  let manager: string;
  let stranger: string;

  const get = (url: string, cookie?: string) =>
    t.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
  const post = (url: string, payload: object, cookie?: string) =>
    t.inject({
      method: 'POST',
      url,
      payload,
      headers: cookie ? { cookie } : {},
    });

  const idFrom = (location: unknown, pattern: RegExp) => {
    const match = pattern.exec(String(location));
    if (!match) throw new Error(`Unexpected redirect ${String(location)}`);
    return Number(match[1]);
  };

  /** A closet garment through the garment form, properties included. */
  const addGarment = async (
    name: string,
    fields: Record<string, string | string[]>,
  ) => {
    const res = await post('/wardrobe', {
      name,
      props: '1',
      care: '1',
      ...fields,
    });
    expect(res.statusCode, res.body).toBe(302);
    return idFrom(res.headers.location, /^\/wardrobe\/(\d+)/);
  };

  /** A wishlist item through the wishlist's form, properties and product included. */
  const addWishlist = async (
    name: string,
    fields: Record<string, string | string[]>,
    cookie?: string,
  ) => {
    const res = await post(
      '/wardrobe',
      {
        name,
        to: 'wishlist',
        wishlist: '1',
        replaces: '',
        props: '1',
        product: '1',
        ...fields,
      },
      cookie,
    );
    expect(res.statusCode, res.body).toBe(302);
    return idFrom(res.headers.location, /^\/wardrobe\/(\d+)/);
  };

  const createPlan = async (name: string, cookie?: string) => {
    const res = await post('/wardrobe/plans', { name, notes: '' }, cookie);
    expect(res.statusCode, res.body).toBe(303);
    return idFrom(res.headers.location, /^\/wardrobe\/plans\/(\d+)\?/);
  };

  const addItem = async (
    planId: number,
    fields: Record<string, string | string[]>,
    cookie?: string,
  ) => {
    const res = await post(
      `/wardrobe/plans/${planId}/items`,
      { quantity: '1', priority: 'medium', ...fields },
      cookie,
    );
    expect(res.statusCode, res.body).toBe(303);
    const rows = await t.db
      .select({ id: planItem.id })
      .from(planItem)
      .where(eq(planItem.planId, planId));
    return Math.max(...rows.map((row) => row.id));
  };

  const candidatesOf = async (itemId: number) =>
    (
      await t.db
        .select({ garmentId: planItemCandidate.garmentId })
        .from(planItemCandidate)
        .where(eq(planItemCandidate.planItemId, itemId))
    )
      .map((row) => row.garmentId)
      .sort((a, b) => a - b);

  const statusOf = async (id: number) =>
    (
      await t.db
        .select({ status: garment.status })
        .from(garment)
        .where(eq(garment.id, id))
    )[0]?.status;

  beforeAll(async () => {
    sites = await startLinkSites();
    t = await createTestApp({}, { outboundFetch: sites.outboundFetch });
    ownerId = await userIdOf(t, 'owner@example.com');
    manager = await t.register('manager-shopping@example.com');
    stranger = await t.register('stranger-shopping@example.com');
    const invite = await createInvite(t.db, ownerId, 'MANAGE');
    const managerId = await userIdOf(t, 'manager-shopping@example.com');
    expect(
      (await acceptInvite(t.db, invite.inviteToken, managerId)).accepted,
    ).toBe(true);
    sites.serve('/img/merino.jpg', jpeg(await productShot('#777777')));
    sites.serve(
      '/products/merino',
      html(`<html><head>
        <meta property="og:title" content="Merino Crew Sweater, Gray">
        <meta property="og:image" content="/img/merino.jpg">
        <meta property="product:price:amount" content="49.90">
        <meta property="product:price:currency" content="USD">
        </head><body></body></html>`),
    );
  });

  afterAll(async () => {
    await t?.cleanup();
    await sites?.close();
  });

  describe('candidates', () => {
    let planId: number;
    let itemId: number;

    beforeAll(async () => {
      planId = await createPlan('Candidates');
      itemId = await addItem(planId, {
        name: 'Grey merino crewneck',
        category: 'tops',
        type: 'sweater',
        colors: 'grey',
        materials: 'merino',
        budget: '50',
      });
    });

    it("links wishlist items from the item's page, and unlinks only what the page showed", async () => {
      const a = await addWishlist('Merino A', {
        category: 'tops',
        price: '45',
      });
      const b = await addWishlist('Merino B', {
        category: 'tops',
        price: '60',
      });
      const page = await get(
        `/wardrobe/plans/${planId}/items/${itemId}/candidates`,
      );
      expect(page.statusCode).toBe(200);
      expectFullPage(page);
      expect(page.body).toContain('Candidates for Grey merino crewneck');
      expect(page.body).toContain('Merino A');
      // Adding by link or photo carries the item to the wishlist's forms.
      const html = unescapeHtml(page.body);
      expect(html).toContain(
        `href="/wardrobe/new/from-link?to=wishlist&planItem=${itemId}"`,
      );
      expect(html).toContain(
        `href="/wardrobe/new?to=wishlist&planItem=${itemId}"`,
      );

      const saved = await post(
        `/wardrobe/plans/${planId}/items/${itemId}/candidates`,
        {
          garmentIds: [String(a), String(b)],
          shown: [String(a), String(b)],
        },
      );
      expect(saved.statusCode).toBe(303);
      expect(saved.headers.location).toBe(`/wardrobe/plans/${planId}?saved=1`);
      expect(await candidatesOf(itemId)).toEqual([a, b]);

      // A page that never showed `c` (added meanwhile) leaves it alone.
      const c = await addWishlist('Merino C', { category: 'tops' });
      await changeCandidates(t.db, ownerId, {
        add: { itemIds: [itemId], garmentIds: [c] },
      });
      const unticked = await post(
        `/wardrobe/plans/${planId}/items/${itemId}/candidates`,
        {
          garmentIds: [String(a)],
          shown: [String(a), String(b)],
          returnTo: '/wardrobe/shopping',
        },
      );
      expect(unticked.headers.location).toBe('/wardrobe/shopping');
      expect(await candidatesOf(itemId)).toEqual([a, c]);
      expect(t.logs.messages('info', 'Web')).toContainEqual(
        `Plan item ${itemId} of plan ${planId}: 0 candidate(s) added, 1 removed by user ${ownerId}`,
      );
      // An off-site returnTo falls back to the plan.
      const offsite = await post(
        `/wardrobe/plans/${planId}/items/${itemId}/candidates`,
        {
          garmentIds: [String(a)],
          shown: [String(a)],
          returnTo: '//evil.example',
        },
      );
      expect(offsite.headers.location).toBe(
        `/wardrobe/plans/${planId}?saved=1`,
      );
    });

    it("links from the wishlist item's side, and the owner's wishlist cards say for what", async () => {
      const d = await addWishlist('Merino D', { category: 'tops' });
      const page = await get(`/wardrobe/${d}/plan-items`);
      expect(page.statusCode).toBe(200);
      expectFullPage(page);
      expect(page.body).toContain('Candidates');
      expect(page.body).toContain('Grey merino crewneck');
      const saved = await post(`/wardrobe/${d}/plan-items`, {
        itemIds: [String(itemId)],
        shown: [String(itemId)],
      });
      expect(saved.statusCode).toBe(303);
      expect(saved.headers.location).toBe('/wardrobe/wishlist');
      expect(await candidatesOf(itemId)).toContain(d);

      const wishlist = unescapeHtml((await get('/wardrobe/wishlist')).body);
      expect(wishlist).toContain('For Grey merino crewneck');
      expect(wishlist).toContain(`href="/wardrobe/${d}/plan-items"`);
      expect(wishlist).toContain('href="/wardrobe/shopping"');

      const removed = await post(`/wardrobe/${d}/plan-items`, {
        shown: [String(itemId)],
      });
      expect(removed.statusCode).toBe(303);
      expect(await candidatesOf(itemId)).not.toContain(d);
    });

    it('adds a candidate with a photo: the wishlist form carries the item and its save links it', async () => {
      const form = await get(`/wardrobe/new?to=wishlist&planItem=${itemId}`);
      expect(form.statusCode).toBe(200);
      expect(form.body).toContain(`name="planItem" value="${itemId}"`);
      expect(form.body).toContain(
        'A candidate for Grey merino crewneck in Candidates',
      );
      const id = await addWishlist('Merino in store', {
        category: 'tops',
        planItem: String(itemId),
      });
      expect(await candidatesOf(itemId)).toContain(id);
      expect(t.logs.messages('info', 'Web')).toContainEqual(
        expect.stringContaining(
          `Garment ${id} created (wishlist) by user ${ownerId}`,
        ),
      );
      expect(t.logs.messages('info', 'Web')).toContainEqual(
        expect.stringContaining(`a candidate for plan item ${itemId}`),
      );
    });

    it('adds a candidate from a link: the imported form carries the item to the save', async () => {
      const imported = await post(
        `/wardrobe/new/from-link?to=wishlist&planItem=${itemId}`,
        { url: sites.url('/products/merino') },
      );
      expect(imported.statusCode, imported.body).toBe(200);
      expect(imported.body).toContain(`name="planItem" value="${itemId}"`);
      const linkPhoto = /name="linkPhoto" value="([^"]+)"/.exec(
        imported.body,
      )![1];
      const id = await addWishlist('Merino Crew Sweater, Gray', {
        category: 'tops',
        linkPhoto,
        planItem: String(itemId),
      });
      expect(await candidatesOf(itemId)).toContain(id);
    });

    it("refuses an item that is not the requester's own, before anything is stored", async () => {
      const theirs = await createPlan('Stranger plan', stranger);
      const theirItem = await addItem(theirs, { category: 'tops' }, stranger);
      expect(
        (await get(`/wardrobe/new?to=wishlist&planItem=${theirItem}`))
          .statusCode,
      ).toBe(404);
      const before = await t.db.$count(garment);
      const refused = await post('/wardrobe', {
        name: 'Sneaky',
        category: 'tops',
        to: 'wishlist',
        wishlist: '1',
        planItem: String(theirItem),
      });
      expect(refused.statusCode).toBe(404);
      expect(await t.db.$count(garment)).toBe(before);
      // A grantee adding to the owner's wishlist has no plans there.
      expect(
        (
          await get(
            `/wardrobe/new?to=wishlist&planItem=${itemId}&ownerId=${ownerId}`,
            manager,
          )
        ).statusCode,
      ).toBe(404);
      // Nor does anyone reach the owner's item or wishlist item pages.
      expect(
        (
          await get(
            `/wardrobe/plans/${planId}/items/${itemId}/candidates`,
            stranger,
          )
        ).statusCode,
      ).toBe(404);
      const [someWish] = await candidatesOf(itemId);
      expect(
        (await get(`/wardrobe/${someWish}/plan-items`, manager)).statusCode,
      ).toBe(404);
      expect(
        (
          await post(
            `/wardrobe/${someWish}/plan-items`,
            { itemIds: [String(theirItem)] },
            stranger,
          )
        ).statusCode,
      ).toBe(404);
    });

    it("links only the owner's wishlist items to the owner's items", async () => {
      const closet = await addGarment('Owned merino', { category: 'tops' });
      const theirWish = await addWishlist(
        'Their merino',
        { category: 'tops' },
        stranger,
      );
      const theirs = await createPlan('Stranger plan 2', stranger);
      const theirItem = await addItem(theirs, { category: 'tops' }, stranger);
      const mine = await addWishlist('My merino', { category: 'tops' });
      expect(
        await changeCandidates(t.db, ownerId, {
          add: {
            itemIds: [itemId, theirItem],
            garmentIds: [closet, theirWish, mine],
          },
        }),
      ).toEqual({ added: 1, removed: 0 });
      expect(await candidatesOf(itemId)).toContain(mine);
      expect(await candidatesOf(itemId)).not.toContain(closet);
      expect(await candidatesOf(theirItem)).toEqual([]);
    });

    it('goes with the item or the garment when either is deleted', async () => {
      // Items of its own: the block's shared item holds the cap by now.
      const gone = await addWishlist('Soon deleted', { category: 'tops' });
      const mine = await addItem(planId, { category: 'tops' });
      const other = await addItem(planId, { category: 'tops' });
      await changeCandidates(t.db, ownerId, {
        add: { itemIds: [mine, other], garmentIds: [gone] },
      });
      const deleted = await t.inject({
        method: 'DELETE',
        url: `/wardrobe/${gone}`,
      });
      expect(deleted.statusCode).toBe(200);
      expect(await candidatesOf(mine)).not.toContain(gone);
      const keep = await addWishlist('Kept', { category: 'tops' });
      await changeCandidates(t.db, ownerId, {
        add: { itemIds: [other], garmentIds: [keep] },
      });
      await t.inject({
        method: 'DELETE',
        url: `/wardrobe/plans/${planId}/items/${other}`,
      });
      expect(await candidatesOf(other)).toEqual([]);
      expect(await statusOf(keep)).toBe('wishlist');
    });

    it('is copied with a duplicated plan', async () => {
      const res = await post(`/wardrobe/plans/${planId}/duplicate`, {});
      const copy = idFrom(res.headers.location, /^\/wardrobe\/plans\/(\d+)\?/);
      const [copied] = await t.db
        .select({ id: planItem.id })
        .from(planItem)
        .where(
          and(
            eq(planItem.planId, copy),
            eq(planItem.name, 'Grey merino crewneck'),
          ),
        );
      expect(await candidatesOf(copied.id)).toEqual(await candidatesOf(itemId));
    });
  });

  describe('the shopping list and Bought it', () => {
    let planId: number;
    let shopper: string;
    const items: Record<string, number> = {};
    const wish: Record<string, number> = {};

    beforeAll(async () => {
      // A fresh owner, so the list is exactly this plan's.
      shopper = await t.register('shopper@example.com');
      planId = await createPlan('NYC minimal', shopper);
      const item = (fields: Record<string, string | string[]>) =>
        addItem(planId, fields, shopper);
      items.merino = await item({
        name: 'Grey merino crewneck',
        category: 'tops',
        type: 'sweater',
        colors: 'grey',
        materials: 'merino',
        priority: 'high',
        budget: '50',
      });
      items.oxford = await item({
        name: 'Oxford shirt',
        category: 'tops',
        type: 'shirt',
        quantity: '3',
        budget: '100',
      });
      items.boots = await item({
        name: 'Black Chelsea boots',
        category: 'footwear',
        type: 'boots',
        colors: 'black',
        budget: '200',
      });
      items.tee = await item({
        name: 'Any tee',
        category: 'tops',
        type: 't-shirt',
      });
      for (const [name, type] of [
        ['Oxford', 'shirt'],
        ['Tee', 't-shirt'],
      ]) {
        const res = await post(
          '/wardrobe',
          { name, category: 'tops', type, props: '1', care: '1' },
          shopper,
        );
        expect(res.statusCode, res.body).toBe(302);
      }
      const w = (name: string, fields: Record<string, string | string[]>) =>
        addWishlist(name, fields, shopper);
      wish.merino = await w('Uniqlo merino', {
        category: 'tops',
        type: 'sweater',
        color: 'grey',
        materials: 'merino',
        price: '49.90',
        sourceUrl: 'https://shop.example/merino',
      });
      wish.merino2 = await w('Pricier merino', {
        category: 'tops',
        type: 'sweater',
        color: 'grey',
        materials: 'merino',
        price: '89',
      });
      wish.navyBoots = await w('Navy boots', {
        category: 'footwear',
        type: 'boots',
        color: 'blue',
        price: '180',
      });
      wish.blackBoots = await w('Black boots', {
        category: 'footwear',
        type: 'boots',
        color: 'black',
        price: '220',
      });
      const shopperId = await userIdOf(t, 'shopper@example.com');
      await changeCandidates(t.db, shopperId, {
        add: {
          itemIds: [items.merino],
          garmentIds: [wish.merino, wish.merino2],
        },
      });
      await changeCandidates(t.db, shopperId, {
        add: {
          itemIds: [items.boots],
          garmentIds: [wish.navyBoots, wish.blackBoots],
        },
      });
      // A photo on the pricier merino, to see its bytes go when it is removed.
      await uploadPhoto(t, wish.merino2, await jpegPhoto(320, 240), shopper);
    });

    it("lists the active plan's gaps, the highest priority first, each with its candidates against the budget", async () => {
      const res = await get('/wardrobe/shopping', shopper);
      expect(res.statusCode).toBe(200);
      expectFullPage(res);
      const html = unescapeHtml(res.body);
      const order = [
        ...html.matchAll(/id="shopping-item-(\d+)" data-status="(\w+)"/g),
      ].map(([, id, status]) => [Number(id), status]);
      // Merino (high, missing), then boots (missing), then the oxford (partly);
      // the owned tee is not shopping.
      expect(order).toEqual([
        [items.merino, 'missing'],
        [items.boots, 'missing'],
        [items.oxford, 'partly'],
      ]);
      expect(html).toContain('2 to buy');
      expect(html).toMatch(
        new RegExp(
          `id="candidate-${wish.merino}" data-budget="within" data-matches="true"`,
        ),
      );
      expect(html).toMatch(
        new RegExp(
          `id="candidate-${wish.merino2}" data-budget="over" data-matches="true"`,
        ),
      );
      expect(html).toMatch(
        new RegExp(
          `id="candidate-${wish.navyBoots}" data-budget="within" data-matches="false"`,
        ),
      );
      expect(html).toContain('Doesn’t match the item: blue vs black');
      expect(html).toContain('href="https://shop.example/merino"');
      expect(html).toContain(`href="/wardrobe/${wish.merino}/bought"`);
      // The matching candidates first: the black boots over the navy ones.
      expect(html.indexOf(`candidate-${wish.blackBoots}`)).toBeLessThan(
        html.indexOf(`candidate-${wish.navyBoots}`),
      );
      // Totals: 4 pieces; budget $50 + $200 + 2 × $100; cheapest matching
      // candidates $49.90 + $220; the oxford has none.
      expect(html).toContain('3 items to find · 4 pieces');
      expect(html).toContain('Budget $450.00');
      expect(html).toContain('Candidates from $269.90');
      expect(html).toContain('1 still without a candidate');
      expect(html).toContain(
        `href="/wardrobe/plans/${planId}/items/${items.oxford}/candidates?returnTo=%2Fwardrobe%2Fshopping"`,
      );
    });

    it("shows another plan's with ?plan=, and a 404 for someone else's", async () => {
      const other = await createPlan('Other plan', shopper);
      const res = await get(`/wardrobe/shopping?plan=${other}`, shopper);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Nothing to buy');
      expect(
        (await get(`/wardrobe/shopping?plan=${planId}`, stranger)).statusCode,
      ).toBe(404);
      expect(
        (await get('/wardrobe/shopping?plan=nope', shopper)).statusCode,
      ).toBe(400);
      const none = await get(
        '/wardrobe/shopping',
        await t.register('planless@example.com'),
      );
      expect(none.statusCode).toBe(200);
      expect(none.body).toContain('No active plan yet');
    });

    it('buys a matching candidate: the item is owned, the other candidate offered and removed with its photo', async () => {
      const page = await get(`/wardrobe/${wish.merino}/bought`, shopper);
      expect(page.statusCode).toBe(200);
      const html = unescapeHtml(page.body);
      expect(html).toContain('For your plans');
      expect(html).toContain('Grey merino crewneck in NYC minimal');
      expect(html).toContain('It fulfils this item.');
      expect(html).toMatch(
        new RegExp(
          `name="removeCandidates" value="${wish.merino2}"[^>]*checked`,
        ),
      );
      const photos = async () =>
        (await readdir(t.dataPath)).filter((name) => name.endsWith('.webp'))
          .length;
      const before = await photos();

      const bought = await post(
        `/wardrobe/${wish.merino}/bought`,
        {
          acquiredOn: t.today(),
          price: '49.90',
          removeCandidates: [String(wish.merino2)],
        },
        shopper,
      );
      expect(bought.statusCode, bought.body).toBe(303);
      expect(await statusOf(wish.merino)).toBe('closet');
      expect(await statusOf(wish.merino2)).toBeUndefined();
      expect(await photos()).toBeLessThan(before);
      const gaps = await get(`/wardrobe/plans/${planId}`, shopper);
      expect(gaps.body).toMatch(
        new RegExp(`id="plan-item-${items.merino}" data-status="owned"`),
      );
      // The bought garment's link is kept and stops mattering: off the list.
      expect(await candidatesOf(items.merino)).toEqual([wish.merino]);
      const list = await get('/wardrobe/shopping', shopper);
      expect(list.body).not.toContain(`shopping-item-${items.merino}`);
      expect(t.logs.messages('info', 'Web')).toContainEqual(
        expect.stringContaining(`Garment ${wish.merino} bought for user`),
      );
    });

    it('says when a candidate does not match, and changes the item only when asked', async () => {
      const page = await get(`/wardrobe/${wish.navyBoots}/bought`, shopper);
      const html = unescapeHtml(page.body);
      expect(html).toContain('This doesn’t match the plan item: blue vs black');
      expect(html).toMatch(
        new RegExp(`name="adjustItems" value="${items.boots}"`),
      );
      expect(html).not.toMatch(
        new RegExp(`name="adjustItems" value="${items.boots}"[^>]*checked`),
      );
      // The item stays short, so the other candidate is offered, not ticked.
      expect(html).toMatch(
        new RegExp(`name="removeCandidates" value="${wish.blackBoots}"`),
      );
      expect(html).not.toMatch(
        new RegExp(
          `name="removeCandidates" value="${wish.blackBoots}"[^>]*checked`,
        ),
      );

      const kept = await post(
        `/wardrobe/${wish.navyBoots}/bought`,
        { acquiredOn: t.today(), price: '180' },
        shopper,
      );
      expect(kept.statusCode).toBe(303);
      expect(await statusOf(wish.navyBoots)).toBe('closet');
      const [item] = await t.db
        .select()
        .from(planItem)
        .where(eq(planItem.id, items.boots));
      expect(item.colors).toEqual(['black']);
      const gaps = await get(`/wardrobe/plans/${planId}`, shopper);
      expect(gaps.body).toMatch(
        new RegExp(`id="plan-item-${items.boots}" data-status="missing"`),
      );
      expect(await statusOf(wish.blackBoots)).toBe('wishlist');
    });

    it('changes the item to match the purchase when asked, and it is owned', async () => {
      const shopperId = await userIdOf(t, 'shopper@example.com');
      const olive = await addWishlist(
        'Olive oxford',
        { category: 'tops', type: 'shirt', color: 'green', price: '80' },
        shopper,
      );
      const scarf = await addItem(
        planId,
        {
          name: 'Navy scarf',
          category: 'accessories',
          colors: 'blue',
          budget: '40',
        },
        shopper,
      );
      const redScarf = await addWishlist(
        'Red scarf',
        { category: 'accessories', color: 'red', price: '30' },
        shopper,
      );
      await changeCandidates(t.db, shopperId, {
        add: { itemIds: [scarf], garmentIds: [redScarf] },
      });
      const bought = await post(
        `/wardrobe/${redScarf}/bought`,
        { acquiredOn: t.today(), price: '30', adjustItems: [String(scarf)] },
        shopper,
      );
      expect(bought.statusCode).toBe(303);
      const [item] = await t.db
        .select()
        .from(planItem)
        .where(eq(planItem.id, scarf));
      expect(item).toMatchObject({
        colors: ['red'],
        category: 'accessories',
        proposed: false,
      });
      const gaps = await get(`/wardrobe/plans/${planId}`, shopper);
      expect(gaps.body).toMatch(
        new RegExp(`id="plan-item-${scarf}" data-status="owned"`),
      );
      // An item it is not a candidate for is left alone, whatever was posted.
      const ignored = await post(
        `/wardrobe/${olive}/bought`,
        {
          acquiredOn: t.today(),
          price: '80',
          adjustItems: [String(items.boots)],
        },
        shopper,
      );
      expect(ignored.statusCode).toBe(303);
      const [boots] = await t.db
        .select()
        .from(planItem)
        .where(eq(planItem.id, items.boots));
      expect(boots.colors).toEqual(['black']);
    });

    it('never shows or takes the plan part from a grantee', async () => {
      const merino = await addWishlist('Owner merino', {
        category: 'tops',
        price: '40',
      });
      const plan = await createPlan('Owner shopping');
      const item = await addItem(plan, {
        name: 'Owner knit',
        category: 'tops',
        colors: 'black',
      });
      await changeCandidates(t.db, ownerId, {
        add: { itemIds: [item], garmentIds: [merino] },
      });

      const page = await get(
        `/wardrobe/${merino}/bought?ownerId=${ownerId}`,
        manager,
      );
      expect(page.statusCode).toBe(200);
      expect(page.body).not.toContain('For your plans');
      expect(page.body).not.toContain('Owner knit');
      const wishlist = await get(
        `/wardrobe/wishlist?ownerId=${ownerId}`,
        manager,
      );
      expect(wishlist.body).toContain('Owner merino');
      expect(wishlist.body).not.toContain('Owner knit');
      expect(wishlist.body).not.toContain('/plan-items');

      const refused = await post(
        `/wardrobe/${merino}/bought?ownerId=${ownerId}`,
        { acquiredOn: t.today(), price: '40', adjustItems: [String(item)] },
        manager,
      );
      expect(refused.statusCode).toBe(403);
      expect(await statusOf(merino)).toBe('wishlist');
      const bought = await post(
        `/wardrobe/${merino}/bought?ownerId=${ownerId}`,
        { acquiredOn: t.today(), price: '40' },
        manager,
      );
      expect(bought.statusCode).toBe(303);
      expect(await statusOf(merino)).toBe('closet');
      const [row] = await t.db
        .select()
        .from(planItem)
        .where(eq(planItem.id, item));
      expect(row.colors).toEqual(['black']);
    });

    it('shows each gap with its candidates on the gap view, and links the list', async () => {
      const res = await get(`/wardrobe/plans/${planId}`, shopper);
      const html = unescapeHtml(res.body);
      expect(html).toContain('href="/wardrobe/shopping"');
      expect(html).toContain(`href="/wardrobe/plans/compare?a=${planId}"`);
      expect(html).toContain(
        `href="/wardrobe/plans/${planId}/items/${items.boots}/candidates"`,
      );
      expect(html).toContain('Black boots · $220.00');
      expect(html).toContain(
        `href="/wardrobe/plans/${planId}/items/${items.oxford}/candidates"`,
      );
    });
  });

  describe('comparing plans', () => {
    it('shows what B adds and drops, and what both have differently', async () => {
      const cookie = await t.register('comparer@example.com');
      const a = await createPlan('Minimal', cookie);
      await addItem(
        a,
        {
          name: 'White tee',
          category: 'tops',
          type: 't-shirt',
          colors: 'white',
          quantity: '3',
        },
        cookie,
      );
      await addItem(
        a,
        { name: 'Parka', category: 'outerwear', type: 'parka' },
        cookie,
      );
      await addItem(
        a,
        { name: 'Chinos', category: 'bottoms', type: 'chinos', quantity: '2' },
        cookie,
      );
      const dup = await post(`/wardrobe/plans/${a}/duplicate`, {}, cookie);
      const b = idFrom(dup.headers.location, /^\/wardrobe\/plans\/(\d+)\?/);
      const [parka] = await t.db
        .select({ id: planItem.id })
        .from(planItem)
        .where(and(eq(planItem.planId, b), eq(planItem.name, 'Parka')));
      await t.inject({
        method: 'DELETE',
        url: `/wardrobe/plans/${b}/items/${parka.id}`,
        headers: { cookie },
      });
      const [tee] = await t.db
        .select({ id: planItem.id })
        .from(planItem)
        .where(and(eq(planItem.planId, b), eq(planItem.name, 'White tee')));
      await post(
        `/wardrobe/plans/${b}/items/${tee.id}`,
        {
          name: 'White tee',
          category: 'tops',
          type: 't-shirt',
          colors: 'white',
          quantity: '4',
          priority: 'medium',
        },
        cookie,
      );
      await addItem(
        b,
        { name: 'Blazer', category: 'outerwear', type: 'blazer' },
        cookie,
      );

      const res = await get(`/wardrobe/plans/compare?a=${a}&b=${b}`, cookie);
      expect(res.statusCode).toBe(200);
      expectFullPage(res);
      const html = unescapeHtml(res.body);
      const section = (id: string) => {
        const start = html.indexOf(`id="${id}"`);
        const end = html.indexOf('</section>', start);
        return html.slice(start, end);
      };
      expect(section('compare-added')).toContain('Blazer');
      expect(section('compare-dropped')).toContain('Parka');
      expect(section('compare-changed')).toContain('White tee');
      expect(section('compare-changed')).toContain('×3 → ×4');
      expect(html).toContain('In both, the same · 1');
      expect(html).toMatch(/data-status="missing"/);

      // Defaults: A is the active plan (the first), B the next.
      const defaults = await get('/wardrobe/plans/compare', cookie);
      expect(defaults.body).toMatch(
        new RegExp(`<option value="${a}" selected`),
      );
      expect(
        (await get(`/wardrobe/plans/compare?a=${a}&b=${b}`, stranger))
          .statusCode,
      ).toBe(404);
      const lonely = await t.register('lonely@example.com');
      await createPlan('Only one', lonely);
      expect((await get('/wardrobe/plans/compare', lonely)).body).toContain(
        'Comparing needs two plans',
      );
    });
  });

  it('keeps a candidate bought while another purchase removes it', async () => {
    const planId = await createPlan('Race plan');
    const itemId = await addItem(planId, {
      name: 'Race tee',
      category: 'tops',
      budget: '30',
    });
    const [bought, other] = [
      await addWishlist('Race tee A', { category: 'tops', price: '20' }),
      await addWishlist('Race tee B', { category: 'tops', price: '25' }),
    ];
    await changeCandidates(t.db, ownerId, {
      add: { itemIds: [itemId], garmentIds: [bought, other] },
    });
    const purchase = { acquiredOn: t.today(), price: '25' };

    // B's "Bought it" holds its transaction open after the buy. A's reads
    // B as a wishlist candidate (B's buy is not committed), buys A, then
    // waits on B's row to remove it; once B commits, B is in the closet.
    let boughtOther!: () => void;
    const otherBought = new Promise<void>((resolve) => (boughtOther = resolve));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const first = t.db.transaction(async (tx) => {
      const outcome = await buyGarment(tx, other, ownerId, {
        ...purchase,
        archiveReplaced: false,
      });
      expect(outcome.ok).toBe(true);
      boughtOther();
      await held;
    });
    await otherBought;
    let secondDone = false;
    const second = buyCandidate(
      {
        db: t.db,
        photos: t.photos,
        logger: t.logger.child({ context: 'Web' }),
        cutouts: t.cutouts,
      },
      bought,
      ownerId,
      { ...purchase, archiveReplaced: false },
      { adjustItems: [], removeCandidates: [other] },
    ).finally(() => (secondDone = true));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(secondDone).toBe(false);
    release();
    await first;
    const outcome = await second;

    expect(outcome).toMatchObject({ ok: true, removed: [] });
    expect(await statusOf(bought)).toBe('closet');
    expect(await statusOf(other)).toBe('closet');
    expect(t.logs.messages('info', 'Web')).toContain(
      `Garment ${bought} bought for user ${ownerId}: candidates ${other} kept, no longer on the wishlist`,
    );
  });

  it('is in the Wardrobe menu and the plans list', async () => {
    const wardrobe = unescapeHtml((await get('/wardrobe')).body);
    expect(wardrobe).toContain('href="/wardrobe/shopping"');
    const plans = unescapeHtml((await get('/wardrobe/plans')).body);
    expect(plans).toContain('href="/wardrobe/shopping"');
    expect(plans).toContain('href="/wardrobe/plans/compare"');
  });
});
