import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garment, planItem, planItemCandidate } from '../../src/db/schema';
import {
  changeCandidates,
  MAX_CANDIDATES_PER_ITEM,
  TooManyCandidates,
} from '../../src/web/plans/candidates';
import { createTestApp, recordQueries, type TestApp } from './harness';
import { callTool, createAccessToken } from './mcp';

/**
 * A plan item's candidates are a curated few (MAX_CANDIDATES_PER_ITEM,
 * src/web/plans/candidates.ts): the one writer, changeCandidates, refuses
 * an add past the cap before writing anything, counted under lockOwner so
 * two adds at once cannot both pass. How each way in answers: the pickers
 * re-render their form 400, the garment form's `planItem` is refused
 * before anything is stored, add_candidate (MCP) is an error (by url,
 * before the page is fetched). Only links still on the wishlist count, and
 * an item past the cap from before keeps its links and may drop some.
 */

const REFUSED = `A plan item takes at most ${MAX_CANDIDATES_PER_ITEM} candidates`;

type Fields = Record<string, string | string[]>;

describe('candidates per plan item', () => {
  let t: TestApp;
  let token: string;
  let planId: number;

  const post = (url: string, payload: Fields) =>
    t.inject({ method: 'POST', url, payload });

  const wishlistItem = async (name: string): Promise<number> => {
    const res = await post('/wardrobe', {
      name,
      category: 'tops',
      to: 'wishlist',
      wishlist: '1',
      replaces: '',
    });
    expect(res.statusCode, res.body).toBe(302);
    return Number(/^\/wardrobe\/(\d+)/.exec(String(res.headers.location))![1]);
  };

  const planItemIn = async (name: string): Promise<number> => {
    const res = await post(`/wardrobe/plans/${planId}/items`, {
      name,
      category: 'tops',
      quantity: '1',
      priority: 'medium',
    });
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

  /** An item holding `n` fresh wishlist candidates; their ids. */
  const itemWith = async (name: string, n: number) => {
    const itemId = await planItemIn(name);
    const garmentIds: number[] = [];
    for (let i = 0; i < n; i += 1) {
      garmentIds.push(await wishlistItem(`${name} ${i}`));
    }
    await changeCandidates(t.db, t.owner.id, {
      add: { itemIds: [itemId], garmentIds },
    });
    return { itemId, garmentIds };
  };

  beforeAll(async () => {
    t = await createTestApp();
    const plan = await post('/wardrobe/plans', { name: 'Capped', notes: '' });
    expect(plan.statusCode).toBe(303);
    planId = Number(
      /^\/wardrobe\/plans\/(\d+)/.exec(String(plan.headers.location))![1],
    );
    token = await createAccessToken(t);
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  it('holds a curated few', () => {
    expect(MAX_CANDIDATES_PER_ITEM).toBe(5);
  });

  describe("the item's page", () => {
    it('re-renders the form 400 past the cap, with what was ticked, and writes nothing', async () => {
      const { itemId, garmentIds } = await itemWith('Page item', 5);
      const sixth = await wishlistItem('Page item extra');
      const shown = [...garmentIds, sixth].map(String);
      const res = await post(
        `/wardrobe/plans/${planId}/items/${itemId}/candidates`,
        { garmentIds: shown, shown },
      );
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain(REFUSED);
      expect(res.body).toContain('role="alert"');
      // The sixth comes back ticked, as posted.
      expect(res.body).toMatch(
        new RegExp(`value="${sixth}"[^>]*checked|checked[^>]*value="${sixth}"`),
      );
      expect(await candidatesOf(itemId)).toEqual(garmentIds);
    });

    it('takes a swap at the cap: one out, one in', async () => {
      const { itemId, garmentIds } = await itemWith('Swap item', 5);
      const newcomer = await wishlistItem('Swap item extra');
      const kept = garmentIds.slice(1);
      const res = await post(
        `/wardrobe/plans/${planId}/items/${itemId}/candidates`,
        {
          garmentIds: [...kept, newcomer].map(String),
          shown: [...garmentIds, newcomer].map(String),
        },
      );
      expect(res.statusCode).toBe(303);
      expect(await candidatesOf(itemId)).toEqual([...kept, newcomer]);
    });
  });

  it("refuses the wishlist item's plan items past the cap, as a 400 form", async () => {
    const { itemId, garmentIds } = await itemWith('Other side', 5);
    const extra = await wishlistItem('Other side extra');
    const res = await post(`/wardrobe/${extra}/plan-items`, {
      itemIds: [String(itemId)],
      shown: [String(itemId)],
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain(REFUSED);
    expect(await candidatesOf(itemId)).toEqual(garmentIds);
  });

  it("refuses the garment form's planItem for a full item before anything is stored", async () => {
    const { itemId } = await itemWith('Form item', 5);
    const form = await t.inject({
      method: 'GET',
      url: `/wardrobe/new?to=wishlist&planItem=${itemId}`,
    });
    expect(form.statusCode).toBe(400);
    expect(form.body).toContain(REFUSED);
    const before = await t.db.$count(garment);
    const res = await post('/wardrobe', {
      name: 'Never stored',
      category: 'tops',
      to: 'wishlist',
      wishlist: '1',
      replaces: '',
      planItem: String(itemId),
    });
    expect(res.statusCode).toBe(400);
    expect(await t.db.$count(garment)).toBe(before);
  });

  describe('add_candidate (MCP)', () => {
    it('is refused past the cap, by garmentId', async () => {
      const { itemId, garmentIds } = await itemWith('MCP item', 5);
      const extra = await wishlistItem('MCP item extra');
      const answer = await callTool(t, token, 'add_candidate', {
        itemId,
        garmentId: extra,
      });
      expect(answer.isError).toBe(true);
      expect(answer.value.error).toContain(REFUSED);
      expect(await candidatesOf(itemId)).toEqual(garmentIds);
      // A candidate it already has is no addition: answered, not refused.
      const again = await callTool(t, token, 'add_candidate', {
        itemId,
        garmentId: garmentIds[0],
      });
      expect(again.isError).toBe(false);
    });

    it('is refused by url before the page is fetched', async () => {
      const { itemId } = await itemWith('MCP link item', 5);
      const before = await t.db.$count(garment);
      // Nothing serves this: a fetch would fail differently.
      const answer = await callTool(t, token, 'add_candidate', {
        itemId,
        url: 'https://shop.invalid/products/never-fetched',
      });
      expect(answer.value.error).toContain(REFUSED);
      expect(await t.db.$count(garment)).toBe(before);
    });
  });

  it('lets two adds at once end with at most the cap', async () => {
    const { itemId } = await itemWith('Race item', MAX_CANDIDATES_PER_ITEM - 1);
    const [late, early] = [
      await wishlistItem('Race late'),
      await wishlistItem('Race early'),
    ];
    // The first add holds its transaction open after its count and insert;
    // the second must wait on the owner's lock, then count the first's row.
    let inserted!: () => void;
    const firstInserted = new Promise<void>((resolve) => (inserted = resolve));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const first = t.db.transaction(async (tx) => {
      await changeCandidates(tx, t.owner.id, {
        add: { itemIds: [itemId], garmentIds: [early] },
      });
      inserted();
      await held;
    });
    await firstInserted;
    let secondDone = false;
    const second = changeCandidates(t.db, t.owner.id, {
      add: { itemIds: [itemId], garmentIds: [late] },
    }).finally(() => (secondDone = true));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(secondDone).toBe(false);
    release();
    await first;
    await expect(second).rejects.toBeInstanceOf(TooManyCandidates);
    const linked = await candidatesOf(itemId);
    expect(linked).toHaveLength(MAX_CANDIDATES_PER_ITEM);
    expect(linked).toContain(early);
    expect(linked).not.toContain(late);
  });

  it('judges several sets item by item, in the statements of one (#167)', async () => {
    const full = await itemWith('Sets full', MAX_CANDIDATES_PER_ITEM - 1);
    const open = await itemWith('Sets open', 0);
    const [a, b, c] = [
      await wishlistItem('Sets a'),
      await wishlistItem('Sets b'),
      await wishlistItem('Sets c'),
    ];
    const one = await recordQueries(() =>
      changeCandidates(t.db, t.owner.id, {
        add: [{ itemIds: [full.itemId], garmentIds: [a] }],
      }),
    );
    const two = await recordQueries(() =>
      changeCandidates(t.db, t.owner.id, {
        add: [
          { itemIds: [open.itemId], garmentIds: [b] },
          { itemIds: [open.itemId], garmentIds: [c, b] },
        ],
      }),
    );
    expect(two.statements).toBe(one.statements);
    expect(await candidatesOf(full.itemId)).toEqual(
      [...full.garmentIds, a].sort((x, y) => x - y),
    );
    expect(await candidatesOf(open.itemId)).toEqual(
      [b, c].sort((x, y) => x - y),
    );
    // One set past the cap refuses the whole change: the other item gains
    // nothing either.
    const [d, e] = [await wishlistItem('Sets d'), await wishlistItem('Sets e')];
    const refused = changeCandidates(t.db, t.owner.id, {
      add: [
        { itemIds: [open.itemId], garmentIds: [d] },
        { itemIds: [full.itemId], garmentIds: [e] },
      ],
    });
    await expect(refused).rejects.toBeInstanceOf(TooManyCandidates);
    await expect(refused).rejects.toMatchObject({ itemIds: [full.itemId] });
    expect(await candidatesOf(open.itemId)).not.toContain(d);
  });

  it('counts only candidates still on the wishlist: a bought one frees its place', async () => {
    const { itemId, garmentIds } = await itemWith('Bought item', 5);
    const bought = await post(`/wardrobe/${garmentIds[0]}/bought`, {
      acquiredOn: t.today(),
      price: '10',
    });
    expect(bought.statusCode).toBe(303);
    const extra = await wishlistItem('Bought item extra');
    await changeCandidates(t.db, t.owner.id, {
      add: { itemIds: [itemId], garmentIds: [extra] },
    });
    expect(await candidatesOf(itemId)).toContain(extra);
  });

  it('applies to new links only: an item past the cap from before keeps them and may drop some', async () => {
    const itemId = await planItemIn('Legacy item');
    const garmentIds: number[] = [];
    for (let i = 0; i < MAX_CANDIDATES_PER_ITEM + 2; i += 1) {
      garmentIds.push(await wishlistItem(`Legacy ${i}`));
    }
    // As a row written before the cap existed: straight into the table.
    await t.db
      .insert(planItemCandidate)
      .values(
        garmentIds.map((garmentId) => ({ planItemId: itemId, garmentId })),
      );
    const extra = await wishlistItem('Legacy extra');
    await expect(
      changeCandidates(t.db, t.owner.id, {
        add: { itemIds: [itemId], garmentIds: [extra] },
      }),
    ).rejects.toBeInstanceOf(TooManyCandidates);
    const dropped = await changeCandidates(t.db, t.owner.id, {
      remove: { itemIds: [itemId], garmentIds: [garmentIds[0]] },
    });
    expect(dropped.removed).toBe(1);
    expect(await candidatesOf(itemId)).toEqual(garmentIds.slice(1));
  });
});
