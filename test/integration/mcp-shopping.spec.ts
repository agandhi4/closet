import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garment, planItem, planItemCandidate } from '../../src/db/schema';
import { lockOwner } from '../../src/web/auth/queries';
import { createTestApp, type TestApp } from './harness';
import {
  html,
  jpeg,
  type LinkSites,
  productShot,
  startLinkSites,
} from './link-sites';
import { callTool, createAccessToken, tool } from './mcp';

/**
 * The shopping loop's MCP tools (#34, slice 34b), driven like a client:
 * get_plan_gaps with each item's candidates, get_shopping_list,
 * add_candidate (a wishlist item, or a product link imported onto the
 * wishlist), add_garment_from_link's planItemId (#295) and compare_plans. The caller's own plans: another user's item
 * is "not found", another's garment too.
 */

interface CandidateOut {
  garmentId: number;
  name: string | null;
  price: string | null;
  matches: boolean;
  differences: { property: string }[];
  budget?: string;
}

interface ShoppingOut {
  plan: { id: number; name: string; active: boolean };
  items: {
    id: number;
    name: string | null;
    status: string;
    toBuy: number;
    candidates: CandidateOut[];
  }[];
  totals: {
    items: number;
    pieces: number;
    budget: string;
    itemsWithoutBudget: number;
    cheapestCandidates: string;
    itemsWithoutPricedMatch: number;
  };
}

describe('MCP: the shopping loop', () => {
  let t: TestApp;
  let sites: LinkSites;
  let token: string;
  let strangerToken: string;
  let planId: number;
  let merinoItem: number;
  let jacketItem: number;
  let wishMerino: number;

  const post = (url: string, payload: object, cookie?: string) =>
    t.inject({
      method: 'POST',
      url,
      payload,
      headers: cookie ? { cookie } : {},
    });
  const idIn = (location: unknown) =>
    Number(/\/(\d+)(\?|$)/.exec(String(location))![1]);

  const addItem = async (fields: Record<string, string>) => {
    await post(`/wardrobe/plans/${planId}/items`, {
      quantity: '1',
      priority: 'medium',
      ...fields,
    });
    const gaps = await tool<{ missing: { id: number; name: string }[] }>(
      t,
      token,
      'get_plan_gaps',
    );
    return gaps.missing.find((item) => item.name === fields.name)!.id;
  };

  beforeAll(async () => {
    sites = await startLinkSites();
    t = await createTestApp({}, { outboundFetch: sites.outboundFetch });
    token = await createAccessToken(t);
    const stranger = await t.register('stranger-mcp-shopping@example.com');
    strangerToken = await createAccessToken(t, { cookie: stranger });
    sites.serve('/img/jacket.jpg', jpeg(await productShot('#553311')));
    sites.serve(
      '/products/jacket',
      html(`<html><head>
        <meta property="og:title" content="Padded Shirt Jacket, Dark Brown">
        <meta property="og:image" content="/img/jacket.jpg">
        </head><body></body></html>`),
    );
    planId = idIn(
      (await post('/wardrobe/plans', { name: 'NYC minimal' })).headers.location,
    );
    merinoItem = await addItem({
      name: 'Grey merino crewneck',
      category: 'tops',
      type: 'sweater',
      colors: 'grey',
      priority: 'high',
      budget: '50',
    });
    jacketItem = await addItem({
      name: 'Brown padded shirt jacket',
      category: 'outerwear',
      type: 'jacket',
      colors: 'brown',
      budget: '90',
    });
    wishMerino = idIn(
      (
        await post('/wardrobe', {
          name: 'Uniqlo merino',
          category: 'tops',
          type: 'sweater',
          color: 'grey',
          to: 'wishlist',
          wishlist: '1',
          props: '1',
          product: '1',
          price: '49.90',
          sourceUrl: 'https://shop.example/merino',
        })
      ).headers.location,
    );
  });

  afterAll(async () => {
    await t?.cleanup();
    await sites?.close();
  });

  it('add_candidate links a wishlist item of the caller’s, not a proposal', async () => {
    const answer = await tool<{ itemId: number; candidate: CandidateOut }>(
      t,
      token,
      'add_candidate',
      { itemId: merinoItem, garmentId: wishMerino },
    );
    expect(answer.itemId).toBe(merinoItem);
    expect(answer.candidate).toMatchObject({
      garmentId: wishMerino,
      name: 'Uniqlo merino',
      price: '49.90',
      matches: true,
      differences: [],
    });
    const rows = await t.db
      .select()
      .from(planItemCandidate)
      .where(eq(planItemCandidate.planItemId, merinoItem));
    expect(rows.map((row) => row.garmentId)).toEqual([wishMerino]);
    expect(t.logs.messages('info', 'Web')).toContainEqual(
      `Garment ${wishMerino} added as a candidate for plan item ${merinoItem} by user ${t.owner.id} (MCP)`,
    );
  });

  it('add_candidate imports a product link onto the wishlist and links it in the same save', async () => {
    const answer = await tool<{ candidate: CandidateOut }>(
      t,
      token,
      'add_candidate',
      {
        itemId: jacketItem,
        url: sites.url('/products/jacket'),
        category: 'outerwear',
        type: 'jacket',
      },
    );
    const [row] = await t.db
      .select({ status: garment.status, name: garment.name })
      .from(garment)
      .where(eq(garment.id, answer.candidate.garmentId));
    expect(row).toEqual({
      status: 'wishlist',
      name: 'Padded Shirt Jacket, Dark Brown',
    });
    // "Dark Brown" in the name reads as brown: the kind the item asks for.
    expect(answer.candidate).toMatchObject({ matches: true, differences: [] });
    const rows = await t.db
      .select()
      .from(planItemCandidate)
      .where(eq(planItemCandidate.planItemId, jacketItem));
    expect(rows.map((r) => r.garmentId)).toEqual([answer.candidate.garmentId]);
  });

  it('refuses what is not the caller’s, or not a wishlist item, and asks for one source', async () => {
    const both = await callTool(t, token, 'add_candidate', {
      itemId: merinoItem,
    });
    expect(both.value.error).toBe('Give either garmentId or url');
    const theirItem = await callTool(t, strangerToken, 'add_candidate', {
      itemId: merinoItem,
      garmentId: wishMerino,
    });
    expect(theirItem.value.error).toBe('Plan item not found');
    const closet = idIn(
      (await post('/wardrobe', { name: 'Owned tee', category: 'tops' })).headers
        .location,
    );
    const owned = await callTool(t, token, 'add_candidate', {
      itemId: merinoItem,
      garmentId: closet,
    });
    expect(owned.value.error).toBe('Only a wishlist item can be a candidate');
  });

  it('get_plan_gaps lists each item’s candidates', async () => {
    const gaps = await tool<{
      missing: { id: number; candidates: CandidateOut[] }[];
    }>(t, token, 'get_plan_gaps');
    const merino = gaps.missing.find((item) => item.id === merinoItem)!;
    expect(merino.candidates.map((c) => c.garmentId)).toEqual([wishMerino]);
  });

  it('get_shopping_list answers the gaps, their candidates against the budget and the totals', async () => {
    const list = await tool<ShoppingOut>(t, token, 'get_shopping_list');
    expect(list.plan).toEqual({
      id: planId,
      name: 'NYC minimal',
      active: true,
    });
    expect(list.items.map((item) => [item.name, item.toBuy])).toEqual([
      ['Grey merino crewneck', 1],
      ['Brown padded shirt jacket', 1],
    ]);
    expect(list.items[0].candidates[0]).toMatchObject({
      garmentId: wishMerino,
      budget: 'within',
      matches: true,
    });
    // The jacket's page named no price: no priced candidate for it yet.
    expect(list.totals).toEqual({
      items: 2,
      pieces: 2,
      budget: '140.00',
      itemsWithoutBudget: 0,
      cheapestCandidates: '49.90',
      itemsWithoutPricedMatch: 1,
    });
    const theirs = await callTool(t, strangerToken, 'get_shopping_list', {
      planId,
    });
    expect(theirs.value.error).toBe('Plan not found');
  });

  it('compare_plans says what one plan adds and drops against another', async () => {
    const dup = await post(`/wardrobe/plans/${planId}/duplicate`, {});
    const copy = idIn(dup.headers.location);
    const answer = await tool<{
      added: unknown[];
      dropped: unknown[];
      both: { changes: string[] }[];
    }>(t, token, 'compare_plans', { a: planId, b: copy });
    expect(answer.added).toEqual([]);
    expect(answer.dropped).toEqual([]);
    expect(answer.both).toHaveLength(2);
    expect(answer.both.every((pair) => pair.changes.length === 0)).toBe(true);
    const theirs = await callTool(t, strangerToken, 'compare_plans', {
      a: planId,
      b: copy,
    });
    expect(theirs.value.error).toBe('Plan not found');
  });

  it('add_candidate by url leaves no wishlist item behind when the item is deleted during the save (#123)', async () => {
    const doomed = await addItem({
      name: 'Doomed scarf',
      category: 'accessories',
    });
    sites.serve(
      '/products/scarf',
      html(`<html><head><meta property="og:title" content="Wool Scarf">
        </head><body></body></html>`),
    );
    const wishlistCount = () =>
      t.db.$count(garment, eq(garment.status, 'wishlist'));
    const before = await wishlistCount();
    // The owner lock held while the item is deleted: the save's link waits
    // behind it, then finds the item gone.
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const deleter = t.db.transaction(async (tx) => {
      await lockOwner(tx, t.owner.id);
      await tx.delete(planItem).where(eq(planItem.id, doomed));
      locked();
      await released;
    });
    await isLocked;
    const added = callTool(t, token, 'add_candidate', {
      itemId: doomed,
      url: sites.url('/products/scarf'),
    });
    await expect
      .poll(async () => {
        const { rows } = await t.db.execute<{ waiting: number }>(
          sql`select count(*)::int as waiting from pg_stat_activity
              where datname = current_database() and wait_event_type = 'Lock'`,
        );
        return rows[0].waiting;
      })
      .toBe(1);
    release();
    await deleter;
    const answer = await added;
    expect(answer.isError).toBe(true);
    expect(answer.value.error).toBe('Plan item not found');
    expect(await wishlistCount()).toBe(before);
  });

  describe('add_garment_from_link with planItemId (#295)', () => {
    const linksOf = async (itemId: number) =>
      (
        await t.db
          .select({ garmentId: planItemCandidate.garmentId })
          .from(planItemCandidate)
          .where(eq(planItemCandidate.planItemId, itemId))
      ).map((row) => row.garmentId);

    beforeAll(() => {
      sites.serve(
        '/products/sneakers',
        html(`<html><head><meta property="og:title" content="Leather Sneaker, White">
          </head><body></body></html>`),
      );
    });

    it('saves the product to the wishlist as the item’s candidate, in the garment’s own save', async () => {
      const sneakers = await addItem({
        name: 'White leather sneakers',
        category: 'footwear',
        colors: 'white',
      });
      const answer = await tool<{
        garment: { id: number };
        candidateFor: { planItemId: number };
      }>(t, token, 'add_garment_from_link', {
        url: sites.url('/products/sneakers'),
        category: 'footwear',
        planItemId: sneakers,
      });
      expect(answer.candidateFor).toEqual({ planItemId: sneakers });
      const [row] = await t.db
        .select({ status: garment.status })
        .from(garment)
        .where(eq(garment.id, answer.garment.id));
      expect(row.status).toBe('wishlist');
      expect(await linksOf(sneakers)).toEqual([answer.garment.id]);
      expect(t.logs.messages('info', 'Web')).toContainEqual(
        `Garment ${answer.garment.id} added as a candidate for plan item ${sneakers} by user ${t.owner.id} (MCP, add_garment_from_link)`,
      );
    });

    it('refuses, before anything is fetched or saved, a full item, a declined one, another user’s and the closet', async () => {
      const wishlistCount = () =>
        t.db.$count(garment, eq(garment.status, 'wishlist'));
      const full = await addItem({
        name: 'Full belt',
        category: 'accessories',
      });
      const belts: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        belts.push(
          idIn(
            (
              await post('/wardrobe', {
                name: `Belt ${i}`,
                category: 'accessories',
                to: 'wishlist',
                wishlist: '1',
              })
            ).headers.location,
          ),
        );
      }
      await t.db
        .insert(planItemCandidate)
        .values(belts.map((garmentId) => ({ planItemId: full, garmentId })));
      const declined = await addItem({
        name: 'Declined loafers',
        category: 'footwear',
      });
      await t.db
        .update(planItem)
        .set({ review: 'declined' })
        .where(eq(planItem.id, declined));
      const before = await wishlistCount();
      const call = (args: Record<string, unknown>, as = token) =>
        callTool(t, as, 'add_garment_from_link', {
          url: sites.url('/products/sneakers'),
          ...args,
        });

      const pastCap = await call({ planItemId: full });
      expect(pastCap.isError).toBe(true);
      expect(pastCap.value.error).toContain('at most 5 candidates');
      expect(await linksOf(full)).toEqual(belts);
      const onDeclined = await call({ planItemId: declined });
      expect(onDeclined.value.error).toBe(
        'You declined this item: reconsider it before adding products.',
      );
      expect(await linksOf(declined)).toEqual([]);
      const theirs = await call({ planItemId: merinoItem }, strangerToken);
      expect(theirs.value.error).toBe('Plan item not found');
      const closet = await call({
        planItemId: merinoItem,
        destination: 'closet',
      });
      expect(closet.value.error).toBe(
        'A plan item’s candidate goes on the wishlist',
      );
      expect(await wishlistCount()).toBe(before);
    });
  });
});
