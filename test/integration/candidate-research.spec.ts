import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planItemCandidate } from '../../src/db/schema';
import {
  CANDIDATE_NOTE_MAX,
  changeCandidates,
} from '../../src/web/plans/candidates';
import { createTestApp, type TestApp, unescapeHtml, userIdOf } from './harness';
import { callTool, createAccessToken, tool } from './mcp';

/**
 * The agent's research on a candidate (#293): a note and a rank written by
 * add_candidate, add_garment_from_link's planItemId and update_candidate
 * (all through changeCandidates), read back by the three plan tools, and
 * drawn on the review strip, the shopping strip and the plan page, which
 * open on the pick. The owner's own adds carry neither.
 */

interface CandidateOut {
  garmentId: number;
  note: string | null;
  rank: number | null;
}

describe('candidate research notes', () => {
  let t: TestApp;
  let token: string;
  let strangerToken: string;
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

  const propose = async () =>
    (
      await tool<{ id: number }>(t, token, 'propose_plan_item', {
        planId,
        category: 'footwear',
        name: `White sneakers ${++seq}`,
      })
    ).id;

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
    token = await createAccessToken(t);
    strangerToken = await createAccessToken(t, {
      cookie: await t.register('stranger-research@example.com'),
    });
    strangerId = await userIdOf(t, 'stranger-research@example.com');
    const res = await post('/wardrobe/plans', { name: 'Research', notes: '' });
    planId = Number(/\/plans\/(\d+)/.exec(String(res.headers.location))![1]);
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  describe('writing', () => {
    it('add_candidate stores a note and rank, and the three plan tools return them', async () => {
      const item = await propose();
      const cheap = await wishlist('Cheap pair', '40');
      const pick = await wishlist('Leather pair', '120');
      await tool(t, token, 'add_candidate', { itemId: item, garmentId: cheap });
      const added = await tool<{ candidate: CandidateOut }>(
        t,
        token,
        'add_candidate',
        {
          itemId: item,
          garmentId: pick,
          note: 'Full-grain leather, runs half a size big',
          rank: 1,
        },
      );
      expect(added.candidate).toMatchObject({
        garmentId: pick,
        note: 'Full-grain leather, runs half a size big',
        rank: 1,
      });
      expect(await rowOf(item, cheap)).toEqual({ note: null, rank: null });

      // The ranked one comes first, ahead of the cheaper, older, unranked one.
      const gaps = await tool<{
        proposed: { id: number; candidates: CandidateOut[] }[];
      }>(t, token, 'get_plan_gaps', { planId });
      expect(
        gaps.proposed
          .find((i) => i.id === item)!
          .candidates.map((c) => [c.garmentId, c.rank]),
      ).toEqual([
        [pick, 1],
        [cheap, null],
      ]);
      // get_plan_feedback lists an item the owner sent back with its candidates.
      const changed = await post(
        `/wardrobe/plans/${planId}/items/${item}/change`,
        { note: 'Not leather' },
      );
      expect(changed.statusCode, changed.body).toBe(303);
      const feedback = await tool<{
        revise: { id: number; candidates: CandidateOut[] }[];
      }>(t, token, 'get_plan_feedback', { planId });
      expect(
        feedback.revise.find((i) => i.id === item)!.candidates[0],
      ).toMatchObject({ garmentId: pick, note: expect.any(String), rank: 1 });
    });

    it('update_candidate sets and clears each field apart, and only on a current candidate of the caller’s item', async () => {
      const item = await propose();
      const first = await wishlist('First');
      const second = await wishlist('Second');
      await tool(t, token, 'add_candidate', { itemId: item, garmentId: first });
      const set = await tool<{ candidate: CandidateOut }>(
        t,
        token,
        'update_candidate',
        { itemId: item, garmentId: first, note: 'Waxed canvas', rank: 2 },
      );
      expect(set.candidate).toMatchObject({ note: 'Waxed canvas', rank: 2 });

      await tool(t, token, 'update_candidate', {
        itemId: item,
        garmentId: first,
        rank: null,
      });
      expect(await rowOf(item, first)).toEqual({
        note: 'Waxed canvas',
        rank: null,
      });
      await tool(t, token, 'update_candidate', {
        itemId: item,
        garmentId: first,
        note: null,
        rank: 3,
      });
      expect(await rowOf(item, first)).toEqual({ note: null, rank: 3 });

      const notCandidate = await callTool(t, token, 'update_candidate', {
        itemId: item,
        garmentId: second,
        rank: 1,
      });
      expect(notCandidate).toMatchObject({ isError: true });
      expect(notCandidate.value.error).toBe(
        'Not a current candidate of this plan item',
      );
      const stranger = await callTool(t, strangerToken, 'update_candidate', {
        itemId: item,
        garmentId: first,
        rank: 1,
      });
      expect(stranger.value.error).toBe('Plan item not found');
      expect(await rowOf(item, first)).toEqual({ note: null, rank: 3 });
    });

    it('refuses a rank out of range, an empty call, a blank or over-long note, and a note on a link that exists', async () => {
      const item = await propose();
      const garmentId = await wishlist('Ranged');
      await tool(t, token, 'add_candidate', { itemId: item, garmentId });
      const refused = [
        { rank: 0 },
        { rank: 6 },
        { rank: 1.5 },
        {},
        { note: '   ' },
        { note: 'x'.repeat(CANDIDATE_NOTE_MAX + 1) },
      ];
      for (const fields of refused) {
        const answer = await callTool(t, token, 'update_candidate', {
          itemId: item,
          garmentId,
          ...fields,
        });
        expect(answer.isError, JSON.stringify(fields)).toBe(true);
      }
      const outOfRange = await callTool(t, token, 'add_candidate', {
        itemId: item,
        garmentId: await wishlist('Another'),
        rank: 9,
      });
      expect(outOfRange.isError).toBe(true);
      expect(await rowOf(item, garmentId)).toEqual({ note: null, rank: null });

      const again = await callTool(t, token, 'add_candidate', {
        itemId: item,
        garmentId,
        note: 'Second thoughts',
      });
      expect(again.value.error).toMatch(/update_candidate/);
      expect(await rowOf(item, garmentId)).toEqual({ note: null, rank: null });
    });

    it('refuses an update on a declined item, and one for a bought candidate', async () => {
      const item = await propose();
      const garmentId = await wishlist('Declined one');
      await tool(t, token, 'add_candidate', { itemId: item, garmentId });
      const declined = await post(
        `/wardrobe/plans/${planId}/items/${item}/decline`,
        {},
      );
      expect(declined.statusCode, declined.body).toBe(303);
      const answer = await callTool(t, token, 'update_candidate', {
        itemId: item,
        garmentId,
        rank: 1,
      });
      expect(answer.isError).toBe(true);
      expect(await rowOf(item, garmentId)).toEqual({ note: null, rank: null });
    });

    it('add_garment_from_link’s planItemId path needs the item for a note', async () => {
      const answer = await callTool(t, token, 'add_garment_from_link', {
        url: 'https://shop.example/x',
        candidateNote: 'No item',
      });
      expect(answer.value.error).toBe(
        'candidateNote and candidateRank go with planItemId',
      );
    });

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
      await tool(t, token, 'add_candidate', {
        itemId: item,
        garmentId,
        note: 'Travels along',
        rank: 1,
      });
      // Proposed items are copied with their review, candidates and all.
      const res = await post(`/wardrobe/plans/${planId}/duplicate`, {});
      const copy = Number(
        /\/plans\/(\d+)/.exec(String(res.headers.location))![1],
      );
      const gaps = await tool<{
        proposed: { candidates: CandidateOut[] }[];
      }>(t, token, 'get_plan_gaps', { planId: copy });
      const copied = gaps.proposed
        .flatMap((i) => i.candidates)
        .find((c) => c.garmentId === garmentId);
      expect(copied).toMatchObject({ note: 'Travels along', rank: 1 });
    });
  });

  describe('the pages', () => {
    let ranked: { plan: number; item: number; pick: number; other: number };

    beforeAll(async () => {
      const res = await post('/wardrobe/plans', { name: 'Pages', notes: '' });
      const plan = Number(
        /\/plans\/(\d+)/.exec(String(res.headers.location))![1],
      );
      const item = (
        await tool<{ id: number }>(t, token, 'propose_plan_item', {
          planId: plan,
          category: 'footwear',
          name: 'Court sneakers',
        })
      ).id;
      // Cheaper and older: today's order would open on it.
      const other = await wishlist('Cheap court shoe', '30');
      const pick = await wishlist('Pricey court shoe', '150');
      await tool(t, token, 'add_candidate', { itemId: item, garmentId: other });
      await tool(t, token, 'add_candidate', {
        itemId: item,
        garmentId: pick,
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

    it('the shopping strip opens on the pick and shows its note', async () => {
      await post(
        `/wardrobe/plans/${ranked.plan}/items/${ranked.item}/accept`,
        {},
      );
      await post(`/wardrobe/plans/${ranked.plan}/activate`, {});
      const page = await get(`/wardrobe/shopping?plan=${ranked.plan}`);
      expect(page).toMatch(
        new RegExp(`data-snap-value="${ranked.pick}" data-selected`),
      );
      expect(page).toContain('Italian leather, true to size');
      expect(page.match(/data-agents-pick/g)).toHaveLength(1);
    });

    it('the plan page’s card leads with the pick', async () => {
      const page = await get(`/wardrobe/plans/${ranked.plan}`);
      expect(page).toContain('data-agents-pick');
    });

    it('a note is escaped', async () => {
      await tool(t, token, 'update_candidate', {
        itemId: ranked.item,
        garmentId: ranked.other,
        note: '<script>alert(1)</script>',
      });
      const res = await t.inject({
        method: 'GET',
        url: `/wardrobe/shopping?plan=${ranked.plan}`,
      });
      expect(res.body).not.toContain('<script>alert(1)</script>');
    });
  });
});
