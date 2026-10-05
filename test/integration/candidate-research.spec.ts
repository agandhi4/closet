import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planItem, planItemCandidate } from '../../src/db/schema';
import {
  CANDIDATE_NOTE_MAX,
  changeCandidates,
} from '../../src/web/plans/candidates';
import { addItems } from '../../src/web/plans/queries';
import { createTestApp, type TestApp, unescapeHtml, userIdOf } from './harness';

/**
 * The agent's research on a candidate (#293): a note and a rank written
 * through changeCandidates (the agent's plan tools wrote them until #337
 * retired them), and drawn on the review strip, the shopping strip and the
 * plan page, which open on the pick. The owner's own adds carry neither.
 */

describe('candidate research notes', () => {
  let t: TestApp;
  let planId: number;
  let strangerId: number;
  let seq = 0;

  const post = (url: string, payload: object) =>
    t.inject({ method: 'POST', url, payload });
  const get = async (url: string) => {
    const res = await t.inject({ method: 'GET', url });
    expect(res.statusCode, res.body).toBe(200);
    return unescapeHtml(res.body);
  };

  /** An agent's proposed item of plan `plan`, as propose_plan_item wrote one. */
  const propose = async (plan = planId, name = `White sneakers ${++seq}`) =>
    (await addItems(
      t.db,
      t.owner.id,
      plan,
      [
        {
          name,
          category: 'footwear',
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

  /** An agent's candidate with its research, as add_candidate wrote one. */
  const research = (
    itemId: number,
    garmentId: number,
    found: { note: string | null; rank: number | null } = {
      note: null,
      rank: null,
    },
  ) =>
    changeCandidates(t.db, t.owner.id, {
      add: {
        itemIds: [itemId],
        garmentIds: [garmentId],
        research: new Map([[garmentId, found]]),
      },
    });

  const wishlist = async (name: string, price = '80') => {
    const res = await post('/wardrobe', {
      name,
      to: 'wishlist',
      wishlist: '1',
      replaces: '',
      props: '1',
      product: '1',
      category: 'footwear',
      price,
      sourceUrl: 'https://shop.example/sneaker',
    });
    expect(res.statusCode, res.body).toBe(302);
    return Number(/\/wardrobe\/(\d+)/.exec(String(res.headers.location))![1]);
  };

  const rowOf = async (itemId: number, garmentId: number) =>
    (
      await t.db
        .select({ note: planItemCandidate.note, rank: planItemCandidate.rank })
        .from(planItemCandidate)
        .where(
          and(
            eq(planItemCandidate.planItemId, itemId),
            eq(planItemCandidate.garmentId, garmentId),
          ),
        )
    )[0];

  beforeAll(async () => {
    t = await createTestApp();
    await t.register('stranger-research@example.com');
    strangerId = await userIdOf(t, 'stranger-research@example.com');
    const res = await post('/wardrobe/plans', { name: 'Research', notes: '' });
    planId = Number(/\/plans\/(\d+)/.exec(String(res.headers.location))![1]);
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  describe('writing', () => {
    it('the owner’s own adds carry no note or rank', async () => {
      const item = await propose();
      const garmentId = await wishlist('Owner added');
      const res = await post(
        `/wardrobe/plans/${planId}/items/${item}/candidates`,
        { garmentIds: [garmentId], shown: [garmentId] },
      );
      expect(res.statusCode, res.body).toBeLessThan(400);
      expect(await rowOf(item, garmentId)).toEqual({ note: null, rank: null });
    });

    it('the writer adds with research and updates it under one call', async () => {
      const item = await propose();
      const a = await wishlist('Writer A');
      const b = await wishlist('Writer B');
      const result = await changeCandidates(t.db, t.owner.id, {
        add: {
          itemIds: [item],
          garmentIds: [a, b],
          research: new Map([[a, { note: 'Kept', rank: 2 }]]),
        },
      });
      expect(result).toEqual({ added: 2, removed: 0, updated: 0 });
      expect(await rowOf(item, a)).toEqual({ note: 'Kept', rank: 2 });
      expect(await rowOf(item, b)).toEqual({ note: null, rank: null });
      // A link that exists keeps its research when added again.
      await changeCandidates(t.db, t.owner.id, {
        add: {
          itemIds: [item],
          garmentIds: [a],
          research: new Map([[a, { note: 'Overwritten', rank: 1 }]]),
        },
      });
      expect(await rowOf(item, a)).toEqual({ note: 'Kept', rank: 2 });
      // Another user finds nothing to update.
      const foreign = await changeCandidates(t.db, strangerId, {
        update: [{ itemId: item, garmentId: a, rank: 1 }],
      });
      expect(foreign.updated).toBe(0);
    });

    it('the writer refuses a note past the cap, on add and update, writing nothing', async () => {
      const item = await propose();
      const a = await wishlist('Cap A');
      const b = await wishlist('Cap B');
      const long = 'x'.repeat(CANDIDATE_NOTE_MAX + 1);
      await expect(
        changeCandidates(t.db, t.owner.id, {
          add: {
            itemIds: [item],
            garmentIds: [a],
            research: new Map([[a, { note: long, rank: null }]]),
          },
        }),
      ).rejects.toMatchObject({
        name: 'CandidateNoteTooLong',
        statusCode: 400,
      });
      expect(await rowOf(item, a)).toBeUndefined();
      await changeCandidates(t.db, t.owner.id, {
        add: { itemIds: [item], garmentIds: [b] },
      });
      await expect(
        changeCandidates(t.db, t.owner.id, {
          update: [{ itemId: item, garmentId: b, note: long }],
        }),
      ).rejects.toMatchObject({ name: 'CandidateNoteTooLong' });
      // Blank is no note; spaces around one are trimmed.
      await changeCandidates(t.db, t.owner.id, {
        update: [{ itemId: item, garmentId: b, note: '  fine  ', rank: 2 }],
      });
      expect(await rowOf(item, b)).toEqual({ note: 'fine', rank: 2 });
      await changeCandidates(t.db, t.owner.id, {
        update: [{ itemId: item, garmentId: b, note: '   ' }],
      });
      expect(await rowOf(item, b)).toEqual({ note: null, rank: 2 });
    });

    it('a duplicated plan keeps the research', async () => {
      const item = await propose();
      const garmentId = await wishlist('Duplicated');
      await research(item, garmentId, { note: 'Travels along', rank: 1 });
      // Proposed items are copied with their review, candidates and all.
      const res = await post(`/wardrobe/plans/${planId}/duplicate`, {});
      const copy = Number(
        /\/plans\/(\d+)/.exec(String(res.headers.location))![1],
      );
      const copied = await t.db
        .select({ note: planItemCandidate.note, rank: planItemCandidate.rank })
        .from(planItemCandidate)
        .innerJoin(planItem, eq(planItem.id, planItemCandidate.planItemId))
        .where(
          and(
            eq(planItem.planId, copy),
            inArray(planItemCandidate.garmentId, [garmentId]),
          ),
        );
      expect(copied).toEqual([{ note: 'Travels along', rank: 1 }]);
    });
  });

  describe('the pages', () => {
    let ranked: { plan: number; item: number; pick: number; other: number };

    beforeAll(async () => {
      const res = await post('/wardrobe/plans', { name: 'Pages', notes: '' });
      const plan = Number(
        /\/plans\/(\d+)/.exec(String(res.headers.location))![1],
      );
      const item = await propose(plan, 'Court sneakers');
      // Cheaper and older: today's order would open on it.
      const other = await wishlist('Cheap court shoe', '30');
      const pick = await wishlist('Pricey court shoe', '150');
      await research(item, other);
      await research(item, pick, {
        note: 'Italian leather, true to size',
        rank: 1,
      });
      ranked = { plan, item, pick, other };
    });

    it('the review strip opens on the agent’s pick and shows its note and badge', async () => {
      const page = await get(`/wardrobe/plans/${ranked.plan}/review`);
      expect(page).toMatch(
        new RegExp(
          `data-snap-value="${ranked.item}:${ranked.pick}" data-selected`,
        ),
      );
      expect(page).not.toMatch(
        new RegExp(
          `data-snap-value="${ranked.item}:${ranked.other}" data-selected`,
        ),
      );
      expect(page).toContain('Italian leather, true to size');
      expect(page.match(/data-agents-pick/g)).toHaveLength(1);
      expect(page).toContain('Agent’s pick');
    });

    it('the shopping list leads with the pick and shows its note', async () => {
      await post(
        `/wardrobe/plans/${ranked.plan}/items/${ranked.item}/accept`,
        {},
      );
      await post(`/wardrobe/plans/${ranked.plan}/activate`, {});
      const page = await get(`/wardrobe/shopping?plan=${ranked.plan}`);
      expect(
        page.indexOf(`id="candidate-${ranked.item}-${ranked.pick}"`),
      ).toBeGreaterThan(0);
      expect(
        page.indexOf(`id="candidate-${ranked.item}-${ranked.pick}"`),
      ).toBeLessThan(
        page.indexOf(`id="candidate-${ranked.item}-${ranked.other}"`),
      );
      expect(page).toContain('Italian leather, true to size');
      expect(page.match(/data-agents-pick/g)).toHaveLength(1);
    });

    it('the plan page’s card leads with the pick', async () => {
      const page = await get(`/wardrobe/plans/${ranked.plan}`);
      expect(page).toContain('data-agents-pick');
    });

    it('a note is escaped', async () => {
      await changeCandidates(t.db, t.owner.id, {
        update: [
          {
            itemId: ranked.item,
            garmentId: ranked.other,
            note: '<script>alert(1)</script>',
          },
        ],
      });
      const res = await t.inject({
        method: 'GET',
        url: `/wardrobe/shopping?plan=${ranked.plan}`,
      });
      expect(res.body).not.toContain('<script>alert(1)</script>');
    });
  });
});
