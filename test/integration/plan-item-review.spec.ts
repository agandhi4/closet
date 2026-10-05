import { asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  garment,
  planItem,
  planItemCandidate,
  planItemRejection,
} from '../../src/db/schema';
import { changeCandidates } from '../../src/web/plans/candidates';
import { addItems } from '../../src/web/plans/queries';
import { buyGarment } from '../../src/web/wardrobe/status';
import { createTestApp, type TestApp, unescapeHtml } from './harness';

/**
 * The item review state machine in the app and for the agent (#278): the
 * plan page's Change this…, Don't buy and Reconsider, the review's notes
 * and "Not this one" (a rejection recorded; the product deleted only when
 * it stands for nothing else, else unlinked), matching and the shopping
 * list leaving revise and declined items out,
 * and a duplicate keeping all of it. The machine's every pair:
 * src/wardrobe/plan-review.spec.ts; the review's removal rule:
 * plan-review.spec.ts; the matrix rows: authorization-plans.spec.ts.
 */
describe('the plan item review', () => {
  let t: TestApp;
  let seq = 0;

  const get = (url: string) => t.inject({ method: 'GET', url });
  const post = (url: string, payload: object = {}) =>
    t.inject({ method: 'POST', url, payload });

  const idFrom = (location: unknown, pattern: RegExp) => {
    const match = pattern.exec(String(location));
    if (!match) throw new Error(`Unexpected redirect ${String(location)}`);
    return Number(match[1]);
  };

  /** A new plan of the owner's, never the active one after the first. */
  const createPlan = async () => {
    const res = await post('/wardrobe/plans', { name: `Plan ${++seq}` });
    expect(res.statusCode, res.body).toBe(303);
    return idFrom(res.headers.location, /^\/wardrobe\/plans\/(\d+)\?/);
  };

  /** An item the agent proposed (as propose_plan_item wrote one until #337). */
  const propose = async (
    planId: number,
    fields: { category?: string; name?: string } = {},
  ) =>
    (await addItems(
      t.db,
      t.owner.id,
      planId,
      [
        {
          name: fields.name ?? `Item ${++seq}`,
          category: fields.category ?? 'tops',
          type: null,
          colors: null,
          materials: null,
          warmthMin: null,
          warmthMax: null,
          formalityMin: null,
          formalityMax: null,
          quantity: 1,
          priority: 'medium',
          budget: null,
          note: null,
        },
      ],
      { review: 'proposed' },
    ))![0];

  const addWishlist = async (name: string) => {
    const res = await post('/wardrobe', {
      name,
      to: 'wishlist',
      wishlist: '1',
      replaces: '',
      props: '1',
      product: '1',
      category: 'tops',
      brand: 'Uniqlo',
      price: '25',
      sourceUrl: 'https://shop.example/tee',
    });
    expect(res.statusCode, res.body).toBe(302);
    return idFrom(res.headers.location, /^\/wardrobe\/(\d+)/);
  };

  const link = (itemId: number, garmentIds: number[]) =>
    changeCandidates(t.db, t.owner.id, {
      add: { itemIds: [itemId], garmentIds },
    });

  const rowOf = async (itemId: number) =>
    (
      await t.db
        .select({ review: planItem.review, ownerNote: planItem.ownerNote })
        .from(planItem)
        .where(eq(planItem.id, itemId))
    )[0];

  const candidatesOf = async (itemId: number) =>
    (
      await t.db
        .select({ garmentId: planItemCandidate.garmentId })
        .from(planItemCandidate)
        .where(eq(planItemCandidate.planItemId, itemId))
    )
      .map((row) => row.garmentId)
      .sort((a, b) => a - b);

  const existing = async (ids: number[]) =>
    (
      await t.db
        .select({ id: garment.id })
        .from(garment)
        .where(inArray(garment.id, ids))
    )
      .map((row) => row.id)
      .sort((a, b) => a - b);

  const statuses = (html: string) =>
    Object.fromEntries(
      [...html.matchAll(/id="plan-item-(\d+)" data-status="([a-z]+)"/g)].map(
        (m) => [Number(m[1]), m[2]],
      ),
    );

  /** A review post as the page sends it, every strip's note and reason paired. */
  const review = (
    planId: number,
    strips: {
      itemId: number;
      pick: string | number;
      note?: string;
      offered?: number[];
      rejects?: [number, string][];
    }[],
    extra: Record<string, string> = {},
  ) => {
    const offered = strips.flatMap((s) =>
      (s.offered ?? []).map((g) => ({ item: s.itemId, garment: g, s })),
    );
    return post(`/wardrobe/plans/${planId}/review`, {
      shown: strips.map((s) => String(s.itemId)),
      pick: strips.map((s) => `${s.itemId}:${s.pick}`),
      note: strips.map((s) => s.note ?? ''),
      offered: offered.map((o) => `${o.item}:${o.garment}`),
      reject: strips.flatMap((s) =>
        (s.rejects ?? []).map(([g]) => `${s.itemId}:${g}`),
      ),
      rejectReason: offered.map(
        (o) => o.s.rejects?.find(([g]) => g === o.garment)?.[1] ?? '',
      ),
      ...extra,
    });
  };

  beforeAll(async () => {
    t = await createTestApp();
    // The active plan, so the plans below are the agent's to fill.
    await createPlan();
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  describe('on the plan page', () => {
    it('Change this… needs a note, then sends the item back to the agent with it', async () => {
      const planId = await createPlan();
      const item = await propose(planId);

      const form = await get(`/wardrobe/plans/${planId}/items/${item}/change`);
      expect(form.statusCode).toBe(200);
      expect(form.body).toContain('Note for your agent');

      const blank = await post(
        `/wardrobe/plans/${planId}/items/${item}/change`,
        { note: '   ' },
      );
      expect(blank.statusCode).toBe(400);
      expect(unescapeHtml(blank.body)).toContain('Say what to change');
      expect((await rowOf(item)).review).toBe('proposed');

      const sent = await post(
        `/wardrobe/plans/${planId}/items/${item}/change`,
        { note: ' Darker, and wool ' },
      );
      expect(sent.statusCode).toBe(303);
      expect(await rowOf(item)).toEqual({
        review: 'revise',
        ownerNote: 'Darker, and wool',
      });
      const page = unescapeHtml((await get(`/wardrobe/plans/${planId}`)).body);
      expect(statuses(page)[item]).toBe('revise');
      expect(page).toContain('With your agent');
      expect(page).toContain('Your note: Darker, and wool');
      expect(t.logs.messages('info', 'Web')).toContain(
        `Plan item ${item} of plan ${planId}: change by user ${t.owner.id} with a note`,
      );

      // A second send of the same form: it moved already, a 409.
      const twice = await post(
        `/wardrobe/plans/${planId}/items/${item}/change`,
        { note: 'Again' },
      );
      expect(twice.statusCode).toBe(409);
      expect((await rowOf(item)).ownerNote).toBe('Darker, and wool');
    });

    it("Don't buy keeps the item declined, out of matching; Reconsider brings it back to review", async () => {
      const planId = await createPlan();
      const item = await propose(planId);
      const res = await post(
        `/wardrobe/plans/${planId}/items/${item}/decline`,
        { note: 'Have enough tops' },
      );
      expect(res.statusCode).toBe(303);
      expect(await rowOf(item)).toEqual({
        review: 'declined',
        ownerNote: 'Have enough tops',
      });
      // The edit form takes no save of a declined item.
      const save = await post(`/wardrobe/plans/${planId}/items/${item}`, {
        category: 'tops',
      });
      expect(save.statusCode).toBe(409);
      // Accept is not a move a declined item takes.
      expect(
        (await post(`/wardrobe/plans/${planId}/items/${item}/accept`))
          .statusCode,
      ).toBe(409);

      const back = await post(
        `/wardrobe/plans/${planId}/items/${item}/reconsider`,
      );
      expect(back.statusCode).toBe(303);
      expect(await rowOf(item)).toEqual({
        review: 'proposed',
        ownerNote: null,
      });
      const strips = unescapeHtml(
        (await get(`/wardrobe/plans/${planId}/review`)).body,
      );
      expect(strips).toContain(`name="shown" value="${item}"`);
    });

    it('Change this… on an accepted item takes it out of the plan until the agent revises it', async () => {
      const planId = await createPlan();
      const res = await post(`/wardrobe/plans/${planId}/items`, {
        category: 'tops',
        name: 'Grey sweater',
      });
      expect(res.statusCode).toBe(303);
      const [{ id: item }] = await t.db
        .select({ id: planItem.id })
        .from(planItem)
        .where(eq(planItem.planId, planId));
      const before = (await get(`/wardrobe/plans/${planId}`)).body;
      expect(statuses(before)[item]).toBe('missing');
      expect(before).toContain(`/items/${item}/change`);

      await post(`/wardrobe/plans/${planId}/items/${item}/change`, {
        note: 'Navy instead',
      });
      const [row] = await t.db
        .select({ review: planItem.review, ownerNote: planItem.ownerNote })
        .from(planItem)
        .where(eq(planItem.id, item));
      expect(row).toEqual({ review: 'revise', ownerNote: 'Navy instead' });
    });
  });

  describe('the review post', () => {
    it("records Change this with its note and Don't buy with its own, both kept", async () => {
      const planId = await createPlan();
      const changed = await propose(planId);
      const declined = await propose(planId, { category: 'bottoms' });
      const res = await review(planId, [
        { itemId: changed, pick: 'change', note: 'Linen, not cotton' },
        { itemId: declined, pick: 'decline', note: '' },
      ]);
      expect(res.statusCode, res.body).toBe(303);
      expect(await rowOf(changed)).toEqual({
        review: 'revise',
        ownerNote: 'Linen, not cotton',
      });
      expect(await rowOf(declined)).toEqual({
        review: 'declined',
        ownerNote: null,
      });
      const page = unescapeHtml(
        (await get(`/wardrobe/plans/${planId}/review`)).body,
      );
      expect(page).toContain('id="review-revise"');
      expect(page).toContain('Your note: Linen, not cotton');
      expect(page).toContain('id="review-declined"');
    });

    it('refuses Change this without a note: the page as posted, 400, nothing written', async () => {
      const planId = await createPlan();
      const changed = await propose(planId);
      const res = await review(planId, [
        { itemId: changed, pick: 'change', note: '  ' },
      ]);
      expect(res.statusCode).toBe(400);
      const html = unescapeHtml(res.body);
      expect(html).toContain('Say what to change');
      expect(html).toMatch(
        new RegExp(`name="pick"[^>]*value="${changed}:change"`),
      );
      expect((await rowOf(changed)).review).toBe('proposed');
    });

    it('reads a rejected pick as Keep: accepted without a product, the rejection recorded, nothing else deleted', async () => {
      const planId = await createPlan();
      const item = await propose(planId);
      const pick = await addWishlist('Chinos');
      const other = await addWishlist('Other chinos');
      await link(item, [pick, other]);
      const res = await review(
        planId,
        [
          {
            itemId: item,
            pick,
            offered: [pick, other],
            rejects: [[pick, 'Too pale']],
          },
        ],
        { removeUnpicked: '1' },
      );
      expect(res.statusCode, res.body).toBe(303);
      expect((await rowOf(item)).review).toBe('accepted');
      expect(await existing([pick, other])).toEqual([other]);
      expect(await candidatesOf(item)).toEqual([other]);
      expect(
        await t.db.$count(
          planItemRejection,
          eq(planItemRejection.planItemId, item),
        ),
      ).toBe(1);
    });

    it('Not this one records the product and reason, deletes it when it stands for nothing else, else unlinks it', async () => {
      const planId = await createPlan();
      const otherPlan = await createPlan();
      const item = await propose(planId);
      const elsewhere = await propose(otherPlan);
      const only = await addWishlist('Only here');
      const shared = await addWishlist('Also elsewhere');
      const keeper = await addWishlist('The keeper');
      await link(item, [only, shared, keeper]);
      await link(elsewhere, [shared]);

      const res = await review(planId, [
        {
          itemId: item,
          pick: keeper,
          offered: [only, shared, keeper],
          rejects: [
            [only, 'Too shiny'],
            [shared, ''],
          ],
        },
      ]);
      expect(res.statusCode, res.body).toBe(303);
      expect(res.headers.location).toBe(
        `/wardrobe/plans/${planId}?reviewed=1&removed=1`,
      );
      expect((await rowOf(item)).review).toBe('accepted');
      expect(await existing([only, shared, keeper])).toEqual(
        [shared, keeper].sort((a, b) => a - b),
      );
      expect(await candidatesOf(item)).toEqual([keeper]);
      expect(await candidatesOf(elsewhere)).toEqual([shared]);
      const rejected = await t.db
        .select({
          itemId: planItemRejection.planItemId,
          name: planItemRejection.name,
          brand: planItemRejection.brand,
          url: planItemRejection.url,
          price: planItemRejection.price,
          reason: planItemRejection.reason,
        })
        .from(planItemRejection)
        .where(eq(planItemRejection.planItemId, item))
        .orderBy(asc(planItemRejection.id));
      expect(rejected).toEqual([
        {
          itemId: item,
          name: 'Only here',
          brand: 'Uniqlo',
          url: 'https://shop.example/tee',
          price: '25.00',
          reason: 'Too shiny',
        },
        {
          itemId: item,
          name: 'Also elsewhere',
          brand: 'Uniqlo',
          url: 'https://shop.example/tee',
          price: '25.00',
          reason: null,
        },
      ]);
    });

    it('records nothing for a candidate bought before the post, nor twice on a second post', async () => {
      const planId = await createPlan();
      const item = await propose(planId);
      const bought = await addWishlist('Bought meanwhile');
      await link(item, [bought]);
      await t.db.transaction(async (tx) => {
        const outcome = await buyGarment(tx, bought, t.owner.id, {
          acquiredOn: t.today(),
          price: '25',
          archiveReplaced: false,
        });
        expect(outcome.ok).toBe(true);
      });
      const strip = {
        itemId: item,
        pick: 'keep',
        offered: [bought],
        rejects: [[bought, 'No'] as [number, string]],
      };
      const first = await review(planId, [strip]);
      expect(first.statusCode, first.body).toBe(303);
      expect(await existing([bought])).toEqual([bought]);
      expect(
        await t.db.$count(
          planItemRejection,
          inArray(planItemRejection.planItemId, [item]),
        ),
      ).toBe(0);
      // Decided already: left as it is, nothing recorded.
      expect((await review(planId, [strip])).statusCode).toBe(303);
      expect(
        await t.db.$count(
          planItemRejection,
          inArray(planItemRejection.planItemId, [item]),
        ),
      ).toBe(0);
    });
  });

  describe('what reads the plan', () => {
    it('leaves revise and declined items out of matching and the shopping list', async () => {
      const planId = await createPlan();
      const kept = await propose(planId, {
        name: 'Kept',
        // Nothing in the closet is one: each stays missing while accepted.
        category: 'kilts',
      });
      const revised = await propose(planId, {
        name: 'Revised',
        category: 'kilts',
      });
      const declined = await propose(planId, {
        name: 'Declined',
        category: 'kilts',
      });
      const res = await review(planId, [
        { itemId: kept, pick: 'keep' },
        { itemId: revised, pick: 'change', note: 'Warmer' },
        { itemId: declined, pick: 'decline' },
      ]);
      expect(res.statusCode, res.body).toBe(303);
      const shopping = (await get(`/wardrobe/shopping?plan=${planId}`)).body;
      expect(shopping).toContain(`id="shopping-item-${kept}"`);
      expect(shopping).not.toContain(`id="shopping-item-${revised}"`);
      expect(shopping).not.toContain(`id="shopping-item-${declined}"`);
      const page = (await get(`/wardrobe/plans/${planId}`)).body;
      expect(statuses(page)).toMatchObject({
        [kept]: 'missing',
        [revised]: 'revise',
        [declined]: 'declined',
      });
      expect(unescapeHtml(page)).toContain('0 owned · 0 partly · 1 missing');
    });

    it('duplicates a plan with every review, note and rejection; a declined item’s candidates stay behind', async () => {
      const planId = await createPlan();
      const revised = await propose(planId);
      const declined = await propose(planId, { category: 'bottoms' });
      const product = await addWishlist('Rejected tee');
      const linked = await addWishlist('Declined item’s product');
      await link(revised, [product]);
      await link(declined, [linked]);
      await review(planId, [
        {
          itemId: revised,
          pick: 'change',
          note: 'Navy',
          offered: [product],
          rejects: [[product, 'Wrong neck']],
        },
        { itemId: declined, pick: 'decline', note: 'No shorts' },
      ]);

      const copy = await post(`/wardrobe/plans/${planId}/duplicate`);
      expect(copy.statusCode).toBe(303);
      const copyId = idFrom(copy.headers.location, /\/wardrobe\/plans\/(\d+)/);
      const items = await t.db
        .select({
          id: planItem.id,
          review: planItem.review,
          ownerNote: planItem.ownerNote,
        })
        .from(planItem)
        .where(eq(planItem.planId, copyId))
        .orderBy(asc(planItem.id));
      expect(
        items.map(({ review, ownerNote }) => ({ review, ownerNote })),
      ).toEqual([
        { review: 'revise', ownerNote: 'Navy' },
        { review: 'declined', ownerNote: 'No shorts' },
      ]);
      const copied = await t.db
        .select({
          name: planItemRejection.name,
          reason: planItemRejection.reason,
        })
        .from(planItemRejection)
        .where(eq(planItemRejection.planItemId, items[0].id));
      expect(copied).toEqual([{ name: 'Rejected tee', reason: 'Wrong neck' }]);
      expect(await candidatesOf(items[1].id)).toEqual([]);
      expect(await candidatesOf(declined)).toEqual([linked]);
    });
  });
});
