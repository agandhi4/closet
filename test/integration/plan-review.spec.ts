import { readdir } from 'node:fs/promises';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  garment,
  planItem,
  planItemCandidate,
  wardrobePlan,
} from '../../src/db/schema';
import { changeCandidates } from '../../src/web/plans/candidates';
import { buyGarment } from '../../src/web/wardrobe/status';
import { recordStatements } from '../support/query-recorder';
import { jpegPhoto, uploadPhoto } from './garments';
import { createTestApp, type TestApp, unescapeHtml, userIdOf } from './harness';
import { expectFullPage } from './pages';

/**
 * The plan review (#271, #278): an agent's proposals as strips (Don't buy,
 * Change this…, Keep, the candidates in the shopping list's order), and
 * "Accept these", which accepts, declines, removes the unpicked candidates that stand for
 * nothing else and activates the plan, in one owner transaction. The
 * data-safety cases each have an `it` below: a candidate of another item
 * is kept, a pick is never deleted, only `shown` items are touched, only
 * `offered` candidates are removed, a candidate bought meanwhile is kept, a
 * second post deletes nothing new. Matrix rows: authorization-plans.spec.ts.
 */
describe('the plan review', () => {
  let t: TestApp;
  let seq = 0;

  const get = (url: string, cookie: string) =>
    t.inject({ method: 'GET', url, headers: { cookie } });
  const post = (url: string, payload: object, cookie: string) =>
    t.inject({ method: 'POST', url, payload, headers: { cookie } });

  const idFrom = (location: unknown, pattern: RegExp) => {
    const match = pattern.exec(String(location));
    if (!match) throw new Error(`Unexpected redirect ${String(location)}`);
    return Number(match[1]);
  };

  /** A fresh owner: every case reads only its own plans and wishlist. */
  const newOwner = async () => {
    const email = `reviewer-${++seq}@example.com`;
    const cookie = await t.register(email);
    return { cookie, id: await userIdOf(t, email) };
  };

  const createPlan = async (name: string, cookie: string) => {
    const res = await post('/wardrobe/plans', { name, notes: '' }, cookie);
    expect(res.statusCode, res.body).toBe(303);
    return idFrom(res.headers.location, /^\/wardrobe\/plans\/(\d+)\?/);
  };

  /** An item through the item form, then marked as the agent's proposal. */
  const addItem = async (
    planId: number,
    fields: Record<string, string | string[]>,
    cookie: string,
    { proposed = true } = {},
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
    const id = Math.max(...rows.map((row) => row.id));
    if (proposed) {
      await t.db
        .update(planItem)
        .set({ review: 'proposed' })
        .where(eq(planItem.id, id));
    }
    return id;
  };

  const addWishlist = async (
    name: string,
    fields: Record<string, string | string[]>,
    cookie: string,
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

  const link = (ownerId: number, itemId: number, garmentIds: number[]) =>
    changeCandidates(t.db, ownerId, {
      add: { itemIds: [itemId], garmentIds },
    });

  const existing = async (ids: number[]) =>
    (
      await t.db
        .select({ id: garment.id })
        .from(garment)
        .where(inArray(garment.id, ids))
    )
      .map((row) => row.id)
      .sort((a, b) => a - b);

  const reviewOf = async (ids: number[]) =>
    new Map(
      (
        await t.db
          .select({ id: planItem.id, review: planItem.review })
          .from(planItem)
          .where(inArray(planItem.id, ids))
      ).map((row) => [row.id, row.review]),
    );

  const candidatesOf = async (itemId: number) =>
    (
      await t.db
        .select({ garmentId: planItemCandidate.garmentId })
        .from(planItemCandidate)
        .where(eq(planItemCandidate.planItemId, itemId))
    )
      .map((row) => row.garmentId)
      .sort((a, b) => a - b);

  const activeOf = async (planId: number) =>
    (
      await t.db
        .select({ active: wardrobePlan.active })
        .from(wardrobePlan)
        .where(eq(wardrobePlan.id, planId))
    )[0]?.active;

  /** Every candidate link of `itemIds` now: what a page drawn now offers, and more. */
  const linkedNow = async (itemIds: number[]) =>
    (
      await t.db
        .select({
          itemId: planItemCandidate.planItemId,
          garmentId: planItemCandidate.garmentId,
        })
        .from(planItemCandidate)
        .where(inArray(planItemCandidate.planItemId, itemIds))
    ).map((row) => `${row.itemId}:${row.garmentId}`);

  /** The candidates a drawn review page offers, as its strips post them. */
  const offeredOn = (html: string) =>
    [...html.matchAll(/name="offered" value="([^"]+)"/g)].map((m) => m[1]);

  /**
   * A post as the page sends it: each item's pick, every item shown, the
   * removal box ticked, and the candidates offered those linked now unless
   * `offered` says what an earlier draw showed.
   */
  const review = async (
    planId: number,
    picks: [number, string | number][],
    cookie: string,
    boxes: {
      removeUnpicked?: boolean;
      activate?: boolean;
      offered?: string[];
    } = {},
  ) =>
    post(
      `/wardrobe/plans/${planId}/review`,
      {
        shown: picks.map(([itemId]) => String(itemId)),
        pick: picks.map(([itemId, pick]) => `${itemId}:${pick}`),
        offered:
          boxes.offered ?? (await linkedNow(picks.map(([itemId]) => itemId))),
        ...(boxes.removeUnpicked === false ? {} : { removeUnpicked: '1' }),
        ...(boxes.activate ? { activate: '1' } : {}),
      },
      cookie,
    );

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  describe('the page', () => {
    let owner: { cookie: string; id: number };
    let planId: number;
    const items: Record<string, number> = {};
    const wish: Record<string, number> = {};

    beforeAll(async () => {
      owner = await newOwner();
      await createPlan('Mine', owner.cookie);
      planId = await createPlan('Muse’s draft', owner.cookie);
      const item = (fields: Record<string, string | string[]>) =>
        addItem(planId, fields, owner.cookie);
      // Created out of the strips' order, to see it sorted.
      items.boots = await item({
        name: 'Black boots',
        category: 'footwear',
        colors: 'black',
        budget: '200',
        note: 'Waterproof, for the commute',
      });
      items.lowTop = await item({
        name: 'Any tee',
        category: 'tops',
        priority: 'low',
      });
      items.coat = await item({ name: 'Camel coat', category: 'outerwear' });
      items.highTop = await item({
        name: 'Oxford shirt',
        category: 'tops',
        priority: 'high',
        quantity: '2',
      });
      items.custom = await item({ name: 'A kilt', category: 'kilts' });
      items.accepted = await addItem(
        planId,
        { name: 'Already mine', category: 'tops' },
        owner.cookie,
        { proposed: false },
      );
      wish.navy = await addWishlist(
        'Navy boots',
        { category: 'footwear', color: 'blue', price: '180' },
        owner.cookie,
      );
      wish.black = await addWishlist(
        'Black boots, dear',
        { category: 'footwear', color: 'black', price: '260' },
        owner.cookie,
      );
      wish.cheapBlack = await addWishlist(
        'Black boots, cheap',
        { category: 'footwear', color: 'black', price: '150' },
        owner.cookie,
      );
      await link(owner.id, items.boots, [
        wish.navy,
        wish.black,
        wish.cheapBlack,
      ]);
    });

    it('shows a strip per proposal under its role’s heading, top to toe then by priority, and nothing accepted', async () => {
      const res = await get(`/wardrobe/plans/${planId}/review`, owner.cookie);
      expect(res.statusCode).toBe(200);
      expectFullPage(res);
      const html = unescapeHtml(res.body);
      expect(html).toContain('Review Muse’s draft');
      const order = [...html.matchAll(/id="review-item-(\d+)"/g)].map((m) =>
        Number(m[1]),
      );
      expect(order).toEqual([
        items.coat,
        items.highTop,
        items.lowTop,
        items.boots,
        items.custom,
      ]);
      // #295: a section per role, headed with its count; a custom
      // category is Other, last.
      const sections = [
        ...html.matchAll(
          /id="review-role-([\w-]+)-title"[^>]*>([^<]*) <span[^>]*>· (\d+)</g,
        ),
      ].map((m) => [m[1], m[2], Number(m[3])]);
      expect(sections).toEqual([
        ['layer', 'Layers', 1],
        ['top', 'Tops', 2],
        ['footwear', 'Shoes', 1],
        ['none', 'Other', 1],
      ]);
      expect(html.indexOf('id="review-role-top"')).toBeLessThan(
        html.indexOf(`id="review-item-${items.highTop}"`),
      );
      expect(html).not.toContain(`review-item-${items.accepted}`);
      expect(html).toContain('Waterproof, for the commute');
      expect(html).toContain('up to $200.00 each');
      expect(html).toMatch(/Oxford shirt<span class="text-muted"> ×2/);
    });

    it('offers Don’t buy, Change this and Keep on every strip, then the candidates in the shopping list’s order', async () => {
      const html = unescapeHtml(
        (await get(`/wardrobe/plans/${planId}/review`, owner.cookie)).body,
      );
      const strip = (itemId: number) => {
        const start = html.indexOf(`id="review-item-${itemId}"`);
        return html.slice(start, html.indexOf('</section>', start));
      };
      const values = (itemId: number) =>
        [...strip(itemId).matchAll(/data-snap-value="([^"]+)"/g)].map(
          (m) => m[1],
        );
      // Matching first, within budget before over, then cheapest.
      expect(values(items.boots)).toEqual([
        `${items.boots}:decline`,
        `${items.boots}:change`,
        `${items.boots}:keep`,
        `${items.boots}:${wish.cheapBlack}`,
        `${items.boots}:${wish.black}`,
        `${items.boots}:${wish.navy}`,
      ]);
      expect(values(items.coat)).toEqual([
        `${items.coat}:decline`,
        `${items.coat}:change`,
        `${items.coat}:keep`,
      ]);
      // The strip starts on its best candidate, else on Keep.
      expect(strip(items.boots)).toContain(
        `name="pick" value="${items.boots}:${wish.cheapBlack}"`,
      );
      expect(strip(items.coat)).toContain(
        `name="pick" value="${items.coat}:keep"`,
      );
      expect(strip(items.boots)).toContain(
        `name="shown" value="${items.boots}"`,
      );
      // Each strip posts the candidates it drew, and only those.
      expect(offeredOn(strip(items.boots)).sort()).toEqual(
        [wish.navy, wish.black, wish.cheapBlack]
          .map((id) => `${items.boots}:${id}`)
          .sort(),
      );
      expect(offeredOn(strip(items.coat))).toEqual([]);
      expect(strip(items.boots)).toContain(
        'Doesn’t match the item: blue vs black',
      );
      expect(strip(items.boots)).toContain('Over budget');
      expect(strip(items.boots)).toContain(
        `hx-get="/wardrobe/${wish.navy}/outfit-count" hx-trigger="intersect once"`,
      );
      // The removal box (unticked: the owner opts in) and, for an inactive
      // plan, Make this my plan.
      expect(html).toMatch(/name="removeUnpicked" value="1" class=/);
      expect(html).toMatch(/name="activate" value="1" checked/);
      expect(html).toContain(`import { initSnapStrips } from 'snap-strip'`);
    });

    it('offers no activation for the active plan, and says when nothing is left', async () => {
      const active = await createPlan('Second', owner.cookie);
      await t.db
        .update(wardrobePlan)
        .set({ active: false })
        .where(eq(wardrobePlan.ownerId, owner.id));
      await t.db
        .update(wardrobePlan)
        .set({ active: true })
        .where(eq(wardrobePlan.id, active));
      await addItem(
        active,
        { name: 'A belt', category: 'accessories' },
        owner.cookie,
      );
      const html = unescapeHtml(
        (await get(`/wardrobe/plans/${active}/review`, owner.cookie)).body,
      );
      expect(html).toContain('A belt');
      expect(html).not.toContain('name="activate"');
      // No candidates anywhere: no removal box either.
      expect(html).not.toContain('name="removeUnpicked"');

      const empty = await createPlan('Empty', owner.cookie);
      const none = await get(`/wardrobe/plans/${empty}/review`, owner.cookie);
      expect(none.statusCode).toBe(200);
      expect(unescapeHtml(none.body)).toContain(
        'Nothing left to review: every proposal is decided.',
      );
      expect(none.body).not.toContain('id="review-form"');
    });

    it('is linked from the gap view and the plans list while proposals remain', async () => {
      const page = await get(`/wardrobe/plans/${planId}`, owner.cookie);
      expect(page.body).toContain(
        `href="/wardrobe/plans/${planId}/review" class="btn btn-primary btn-sm shrink-0" id="plan-review"`,
      );
      const list = await get('/wardrobe/plans', owner.cookie);
      expect(list.body).toContain(`href="/wardrobe/plans/${planId}/review"`);
    });

    it('reads the page in 5 statements', async () => {
      const { result, statements } = await recordStatements(() =>
        get(`/wardrobe/plans/${planId}/review`, owner.cookie),
      );
      expect(result.statusCode).toBe(200);
      // The session, the plan, its items, its candidates, its looks (#291).
      expect(statements).toHaveLength(5);
    });
  });

  describe('Accept these', () => {
    it('accepts the picks and Keep, declines Don’t buy, removes what stands for nothing else, activates the plan', async () => {
      const owner = await newOwner();
      const mine = await createPlan('Mine', owner.cookie);
      const planId = await createPlan('Draft', owner.cookie);
      const other = await addItem(
        mine,
        { name: 'Elsewhere', category: 'tops' },
        owner.cookie,
        {
          proposed: false,
        },
      );
      const picked = await addItem(
        planId,
        { name: 'Tee', category: 'tops' },
        owner.cookie,
      );
      const skipped = await addItem(
        planId,
        { name: 'Shorts', category: 'bottoms' },
        owner.cookie,
      );
      const kept = await addItem(
        planId,
        { name: 'Coat', category: 'outerwear' },
        owner.cookie,
      );
      const second = await addItem(
        planId,
        { name: 'Shirt', category: 'tops' },
        owner.cookie,
      );
      const w = (name: string) =>
        addWishlist(name, { category: 'tops' }, owner.cookie);
      const choice = await w('The pick');
      const loser = await w('Unpicked, only here');
      const shared = await w('Unpicked, also elsewhere');
      const crossPicked = await w('Picked for the shirt');
      const skippedOnly = await w('Of the skipped item');
      await uploadPhoto(t, loser, await jpegPhoto(320, 240), owner.cookie);
      await link(owner.id, picked, [choice, loser, shared, crossPicked]);
      await link(owner.id, other, [shared]);
      await link(owner.id, second, [crossPicked]);
      await link(owner.id, skipped, [skippedOnly]);
      const photos = async () =>
        (await readdir(t.dataPath)).filter((name) => name.endsWith('.webp'))
          .length;
      const before = await photos();
      expect(await activeOf(planId)).toBe(false);

      const res = await review(
        planId,
        [
          [picked, choice],
          [skipped, 'decline'],
          [kept, 'keep'],
          [second, crossPicked],
        ],
        owner.cookie,
        { activate: true },
      );
      expect(res.statusCode, res.body).toBe(303);
      expect(res.headers.location).toBe(
        `/wardrobe/plans/${planId}?reviewed=1&removed=2`,
      );

      const states = await reviewOf([picked, skipped, kept, second]);
      expect(states.get(picked)).toBe('accepted');
      expect(states.get(kept)).toBe('accepted');
      expect(states.get(second)).toBe('accepted');
      expect(states.get(skipped)).toBe('declined');
      // Gone: what stood only for the picked item or the skipped one. Kept:
      // the pick, one that stands for another plan's item, and one picked
      // for another strip of this post.
      expect(
        await existing([choice, loser, shared, crossPicked, skippedOnly]),
      ).toEqual([choice, shared, crossPicked].sort((a, b) => a - b));
      expect(await photos()).toBeLessThan(before);
      // The kept ones leave the item they were not picked for.
      expect(await candidatesOf(picked)).toEqual([choice]);
      expect(await candidatesOf(other)).toEqual([shared]);
      expect(await candidatesOf(second)).toEqual([crossPicked]);
      expect(await activeOf(planId)).toBe(true);
      expect(await activeOf(mine)).toBe(false);

      const page = await get(res.headers.location!, owner.cookie);
      expect(page.body).toContain(
        'Review saved. 2 products removed from your wishlist',
      );
      expect(page.body).not.toContain('id="plan-review"');
      expect(t.logs.messages('info', 'Web')).toContain(
        `Plan ${planId} reviewed by user ${owner.id}: accepted ${[picked, kept, second].sort((a, b) => a - b).join(', ')}, changes asked for none, declined ${skipped}, 0 candidates turned down, candidates ${[loser, skippedOnly].sort((a, b) => a - b).join(', ')} removed from the wishlist, made active`,
      );
    });

    it('removes nothing with the box unticked, and leaves the plan inactive unasked', async () => {
      const owner = await newOwner();
      await createPlan('Mine', owner.cookie);
      const planId = await createPlan('Draft', owner.cookie);
      const item = await addItem(
        planId,
        { name: 'Tee', category: 'tops' },
        owner.cookie,
      );
      const skipped = await addItem(
        planId,
        { name: 'Belt', category: 'accessories' },
        owner.cookie,
      );
      const a = await addWishlist('A', { category: 'tops' }, owner.cookie);
      const b = await addWishlist('B', { category: 'tops' }, owner.cookie);
      const c = await addWishlist(
        'C',
        { category: 'accessories' },
        owner.cookie,
      );
      await link(owner.id, item, [a, b]);
      await link(owner.id, skipped, [c]);

      const res = await review(
        planId,
        [
          [item, a],
          [skipped, 'decline'],
        ],
        owner.cookie,
        { removeUnpicked: false },
      );
      expect(res.statusCode, res.body).toBe(303);
      expect(res.headers.location).toBe(`/wardrobe/plans/${planId}?reviewed=1`);
      const page = await get(res.headers.location!, owner.cookie);
      expect(page.body).toContain('Review saved');
      expect(page.body).not.toContain('removed from your wishlist');
      expect(await existing([a, b, c])).toEqual(
        [a, b, c].sort((x, y) => x - y),
      );
      expect(await candidatesOf(item)).toEqual([a, b].sort((x, y) => x - y));
      expect(await activeOf(planId)).toBe(false);
    });

    it('touches only the items the page showed: a later proposal and its candidates stay', async () => {
      const owner = await newOwner();
      const planId = await createPlan('Draft', owner.cookie);
      const shown = await addItem(
        planId,
        { name: 'Tee', category: 'tops' },
        owner.cookie,
      );
      const later = await addItem(
        planId,
        { name: 'Later tee', category: 'tops' },
        owner.cookie,
      );
      const pick = await addWishlist(
        'Pick',
        { category: 'tops' },
        owner.cookie,
      );
      const both = await addWishlist(
        'Both',
        { category: 'tops' },
        owner.cookie,
      );
      await link(owner.id, shown, [pick, both]);
      await link(owner.id, later, [both]);

      const res = await review(planId, [[shown, pick]], owner.cookie);
      expect(res.statusCode, res.body).toBe(303);
      expect((await reviewOf([later])).get(later)).toBe('proposed');
      expect(await existing([both])).toEqual([both]);
      expect(await candidatesOf(later)).toEqual([both]);
    });

    it('removes only the candidates the page offered: one linked after it was drawn stays, linked', async () => {
      const owner = await newOwner();
      const planId = await createPlan('Draft', owner.cookie);
      const picked = await addItem(
        planId,
        { name: 'Tee', category: 'tops' },
        owner.cookie,
      );
      const skipped = await addItem(
        planId,
        { name: 'Shirt', category: 'tops' },
        owner.cookie,
      );
      const w = (name: string) =>
        addWishlist(name, { category: 'tops' }, owner.cookie);
      const pick = await w('The pick');
      const loser = await w('Unpicked, drawn');
      const ofSkipped = await w('Of the skipped item, drawn');
      await link(owner.id, picked, [pick, loser]);
      await link(owner.id, skipped, [ofSkipped]);
      const drawn = await get(`/wardrobe/plans/${planId}/review`, owner.cookie);
      const offered = offeredOn(unescapeHtml(drawn.body));
      expect(offered).toHaveLength(3);

      // After the draw (as add_candidate would), one product for both items.
      const late = await w('Linked after the draw');
      await link(owner.id, picked, [late]);
      await link(owner.id, skipped, [late]);

      const res = await review(
        planId,
        [
          [picked, pick],
          [skipped, 'decline'],
        ],
        owner.cookie,
        { offered },
      );
      expect(res.statusCode, res.body).toBe(303);
      // The drawn unpicked ones go; the late one, never shown, survives
      // Accept (still linked to the picked item) and Don't buy (still linked
      // to the declined item, inert).
      expect(await existing([pick, loser, ofSkipped, late])).toEqual(
        [pick, late].sort((a, b) => a - b),
      );
      expect(await candidatesOf(picked)).toEqual(
        [pick, late].sort((a, b) => a - b),
      );
      expect((await reviewOf([skipped])).get(skipped)).toBe('declined');

      // An offered candidate of an item the post did not show: a 400.
      const refused = await post(
        `/wardrobe/plans/${planId}/review`,
        {
          shown: [String(picked)],
          pick: [`${picked}:keep`],
          offered: [`${skipped}:${late}`],
        },
        owner.cookie,
      );
      expect(refused.statusCode).toBe(400);
    });

    it('releases nothing on Keep, even where the strip offered candidates', async () => {
      const owner = await newOwner();
      const planId = await createPlan('Draft', owner.cookie);
      const item = await addItem(
        planId,
        { name: 'Tee', category: 'tops' },
        owner.cookie,
      );
      const a = await addWishlist('A', { category: 'tops' }, owner.cookie);
      const b = await addWishlist('B', { category: 'tops' }, owner.cookie);
      await link(owner.id, item, [a, b]);

      const res = await review(planId, [[item, 'keep']], owner.cookie);
      expect(res.statusCode, res.body).toBe(303);
      expect((await reviewOf([item])).get(item)).toBe('accepted');
      expect(await existing([a, b])).toEqual([a, b].sort((x, y) => x - y));
      expect(await candidatesOf(item)).toEqual([a, b].sort((x, y) => x - y));
    });

    it('keeps a candidate bought while the review removes it, and says so', async () => {
      const owner = await newOwner();
      const planId = await createPlan('Draft', owner.cookie);
      const item = await addItem(
        planId,
        { name: 'Tee', category: 'tops' },
        owner.cookie,
      );
      const pick = await addWishlist(
        'Pick',
        { category: 'tops' },
        owner.cookie,
      );
      const other = await addWishlist(
        'Other',
        { category: 'tops' },
        owner.cookie,
      );
      await link(owner.id, item, [pick, other]);

      // A purchase of `other` holds its transaction open after the buy (a
      // wishlist buy takes no owner lock): the review reads it as a
      // candidate, then waits on its row; once the buy commits, the delete
      // finds it in the closet and leaves it.
      let bought!: () => void;
      const isBought = new Promise<void>((resolve) => (bought = resolve));
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const buy = t.db.transaction(async (tx) => {
        const outcome = await buyGarment(tx, other, owner.id, {
          acquiredOn: t.today(),
          price: '20',
          archiveReplaced: false,
        });
        expect(outcome.ok).toBe(true);
        bought();
        await held;
      });
      await isBought;
      let done = false;
      const posted = review(planId, [[item, pick]], owner.cookie).finally(
        () => (done = true),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(done).toBe(false);
      release();
      await buy;
      const res = await posted;

      expect(res.statusCode, res.body).toBe(303);
      expect(await existing([pick, other])).toEqual(
        [pick, other].sort((a, b) => a - b),
      );
      expect(t.logs.messages('info', 'Web')).toContain(
        `Plan ${planId} review by user ${owner.id}: candidates ${other} kept, no longer on the wishlist`,
      );
    });

    it('deletes nothing new on a second post: decided items are left as they are', async () => {
      const owner = await newOwner();
      const planId = await createPlan('Draft', owner.cookie);
      const item = await addItem(
        planId,
        { name: 'Tee', category: 'tops' },
        owner.cookie,
      );
      const pick = await addWishlist(
        'Pick',
        { category: 'tops' },
        owner.cookie,
      );
      const loser = await addWishlist(
        'Loser',
        { category: 'tops' },
        owner.cookie,
      );
      await link(owner.id, item, [pick, loser]);

      const first = await review(planId, [[item, pick]], owner.cookie);
      expect(first.statusCode, first.body).toBe(303);
      expect(await existing([loser])).toEqual([]);
      // A candidate added since: the same post again must not take it.
      const added = await addWishlist(
        'Added later',
        { category: 'tops' },
        owner.cookie,
      );
      await link(owner.id, item, [added]);

      const again = await review(planId, [[item, pick]], owner.cookie);
      expect(again.statusCode, again.body).toBe(303);
      expect(await existing([pick, added])).toEqual(
        [pick, added].sort((a, b) => a - b),
      );
      expect(t.logs.messages('info', 'Web')).toContain(
        `Plan ${planId} review by user ${owner.id}: items ${item} left as they are, no longer proposed`,
      );

      // A second post after a Don't buy: declined already, left as it is.
      const skipped = await addItem(
        planId,
        { name: 'Shorts', category: 'bottoms' },
        owner.cookie,
      );
      const ofSkipped = await addWishlist(
        'Of the shorts',
        { category: 'bottoms' },
        owner.cookie,
      );
      await link(owner.id, skipped, [ofSkipped]);
      expect(
        (await review(planId, [[skipped, 'decline']], owner.cookie)).statusCode,
      ).toBe(303);
      const twice = await review(planId, [[skipped, 'decline']], owner.cookie);
      expect(twice.statusCode).toBe(303);
      expect((await reviewOf([skipped])).get(skipped)).toBe('declined');
      expect(await existing([pick, added])).toEqual(
        [pick, added].sort((a, b) => a - b),
      );
    });

    it('refuses another plan’s item and a post the page could not send: the page again, 400, nothing written', async () => {
      const owner = await newOwner();
      const planId = await createPlan('Draft', owner.cookie);
      const otherPlan = await createPlan('Other', owner.cookie);
      const item = await addItem(
        planId,
        { name: 'Tee', category: 'tops' },
        owner.cookie,
      );
      const foreign = await addItem(
        otherPlan,
        { name: 'Not here', category: 'tops' },
        owner.cookie,
      );

      const res = await review(
        planId,
        [
          [item, 'keep'],
          [foreign, 'decline'],
        ],
        owner.cookie,
      );
      expect(res.statusCode).toBe(400);
      expectFullPage(res);
      expect(unescapeHtml(res.body)).toContain('Some of these items changed');
      expect(res.body).toContain(`id="review-item-${item}"`);
      const states = await reviewOf([item, foreign]);
      expect(states.get(item)).toBe('proposed');
      expect(states.get(foreign)).toBe('proposed');

      // A pick for an item not shown, and a shown item without a pick.
      for (const payload of [
        { shown: [String(item)], pick: [`${foreign}:decline`] },
        { shown: [String(item), String(foreign)], pick: [`${item}:keep`] },
        { shown: [String(item)], pick: [`${item}:keep`, `${item}:decline`] },
      ]) {
        const refused = await post(
          `/wardrobe/plans/${planId}/review`,
          payload,
          owner.cookie,
        );
        expect(refused.statusCode).toBe(400);
        expect(unescapeHtml(refused.body)).toContain(
          'Some of these items changed',
        );
      }
      expect((await reviewOf([item])).get(item)).toBe('proposed');
    });

    it("is a 404 for another user's plan, before anything is read or written", async () => {
      const owner = await newOwner();
      const stranger = await newOwner();
      const planId = await createPlan('Draft', owner.cookie);
      const item = await addItem(
        planId,
        { name: 'Tee', category: 'tops' },
        owner.cookie,
      );
      expect(
        (await get(`/wardrobe/plans/${planId}/review`, stranger.cookie))
          .statusCode,
      ).toBe(404);
      const res = await review(planId, [[item, 'decline']], stranger.cookie);
      expect(res.statusCode).toBe(404);
      expect((await reviewOf([item])).get(item)).toBe('proposed');
    });
  });
});
