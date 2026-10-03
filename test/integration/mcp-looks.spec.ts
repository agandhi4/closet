import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garment, planItem, planLook } from '../../src/db/schema';
import { reactToLooks } from '../../src/web/plans/looks';
import { createTestApp, type TestApp } from './harness';
import { callTool, createAccessToken, tool } from './mcp';

/**
 * The plan looks' MCP tools (#290): list_looks, propose_look and
 * update_look, and the looks get_plan_feedback lists for the agent. They
 * call the page writers (plan-looks.spec.ts owns the rules and every
 * refusal); this one proves the tools pass the answers and refusals
 * through, and that plans and looks are the caller's own. The owner's
 * reactions are driven through `reactToLooks`, as #291's routes do.
 */

interface SlotOut {
  garmentId: number | null;
  role: string;
  state: 'owned' | 'to-buy' | 'missing';
  reason?: string;
}

interface LookOut {
  id: number;
  name: string;
  occasion: string | null;
  note: string | null;
  reaction: string;
  ownerNote: string | null;
  slots: SlotOut[];
  missingPieces: { role: string; reason: string }[];
  complete: boolean;
}

interface Feedback {
  planId: number;
  looks: { revise: LookOut[]; declined: LookOut[]; incomplete: LookOut[] };
}

describe('MCP: plan looks (#290)', () => {
  let t: TestApp;
  let token: string;
  let strangerToken: string;
  let ownerId: number;
  let planId: number;
  let tee: number;
  let jeans: number;
  let boots: number;
  let wishSweater: number;
  let wishCoat: number;
  let plainWishlist: number;

  const post = (url: string, payload: object) =>
    t.inject({ method: 'POST', url, payload });
  const idIn = (location: unknown) =>
    Number(/\/(\d+)(\?|$)/.exec(String(location))![1]);
  const closetGarment = async (name: string, category: string, type: string) =>
    idIn(
      (
        await post('/wardrobe', {
          name,
          category,
          type,
          color: 'blue',
          props: '1',
          care: '1',
        })
      ).headers.location,
    );
  const wishlistGarment = async (name: string, category: string) =>
    idIn(
      (
        await post('/wardrobe', {
          name,
          category,
          color: 'grey',
          to: 'wishlist',
          wishlist: '1',
          props: '1',
          product: '1',
        })
      ).headers.location,
    );
  const addItem = async (name: string, category: string) => {
    await post(`/wardrobe/plans/${planId}/items`, {
      name,
      category,
      quantity: '1',
      priority: 'medium',
    });
    const [item] = await t.db
      .select({ id: planItem.id })
      .from(planItem)
      .where(and(eq(planItem.planId, planId), eq(planItem.name, name)));
    return item.id;
  };
  const propose = (garmentIds: number[], extra: object = {}) =>
    tool<{
      id: number;
      planId: number;
      reaction: string;
      alreadyProposed: boolean;
    }>(t, token, 'propose_look', {
      planId,
      name: 'Look',
      garmentIds,
      ...extra,
    });
  const listed = async () =>
    (await tool<{ planId: number; looks: LookOut[] }>(t, token, 'list_looks'))
      .looks;

  beforeAll(async () => {
    t = await createTestApp();
    token = await createAccessToken(t);
    const stranger = await t.register('stranger-mcp-looks@example.com');
    strangerToken = await createAccessToken(t, { cookie: stranger });
    planId = idIn(
      (await post('/wardrobe/plans', { name: 'Looks plan' })).headers.location,
    );
    tee = await closetGarment('Blue tee', 'tops', 't-shirt');
    jeans = await closetGarment('Blue jeans', 'bottoms', 'jeans');
    boots = await closetGarment('Blue boots', 'footwear', 'boots');
    wishSweater = await wishlistGarment('Grey sweater', 'tops');
    wishCoat = await wishlistGarment('Grey coat', 'outerwear');
    plainWishlist = await wishlistGarment('Not a candidate', 'tops');
    const sweaterItem = await addItem('Sweater', 'tops');
    const coatItem = await addItem('Coat', 'outerwear');
    await tool(t, token, 'add_candidate', {
      itemId: sweaterItem,
      garmentId: wishSweater,
    });
    await tool(t, token, 'add_candidate', {
      itemId: coatItem,
      garmentId: wishCoat,
    });
    const [owner] = await t.db
      .select({ id: garment.ownerId })
      .from(garment)
      .where(eq(garment.id, tee));
    ownerId = owner.id;
  });

  afterAll(() => t?.cleanup());

  it('propose_look writes a proposed look of closet pieces and a candidate, and a repeat answers it', async () => {
    const answer = await propose([tee, jeans, wishSweater], {
      name: 'Monday',
      occasion: 'work',
      note: 'Swap the tee for the sweater when it is cold',
    });
    expect(answer).toMatchObject({
      planId,
      reaction: 'proposed',
      alreadyProposed: false,
    });
    const again = await propose([wishSweater, jeans, tee], { name: 'Other' });
    expect(again).toMatchObject({ id: answer.id, alreadyProposed: true });
    expect((await listed()).filter((l) => l.id === answer.id)).toHaveLength(1);
  });

  it('omitting planId proposes into the active plan (the first plan is active)', async () => {
    const answer = await tool<{ planId: number }>(t, token, 'propose_look', {
      name: 'Errands',
      garmentIds: [tee, boots],
    });
    expect(answer.planId).toBe(planId);
  });

  it('list_looks answers each slot owned, to-buy or missing, by occasion', async () => {
    const looks = await listed();
    const monday = looks.find((l) => l.name === 'Monday')!;
    expect(monday).toMatchObject({
      occasion: 'work',
      reaction: 'proposed',
      ownerNote: null,
      complete: false,
      missingPieces: [],
    });
    expect(monday.slots.map((s) => [s.garmentId, s.role, s.state])).toEqual(
      expect.arrayContaining([
        [tee, 'top', 'owned'],
        [jeans, 'bottom', 'owned'],
        [wishSweater, 'top', 'to-buy'],
      ]),
    );
    // Work comes before the lookless ones.
    expect(looks.map((l) => l.occasion)).toEqual(['work', null]);
    const closetOnly = looks.find((l) => l.name === 'Errands')!;
    expect(closetOnly.complete).toBe(true);
  });

  it('passes the writer’s refusals through and writes nothing', async () => {
    const before = (await listed()).length;
    const plain = await callTool(t, token, 'propose_look', {
      planId,
      name: 'Bad',
      garmentIds: [tee, plainWishlist],
    });
    expect(plain).toMatchObject({ isError: true });
    expect(String(plain.value.error)).toContain('Not a candidate');
    const gone = await callTool(t, token, 'propose_look', {
      planId,
      name: 'Bad',
      garmentIds: [tee, 2_000_000_000],
    });
    expect(gone.isError).toBe(true);
    const one = await callTool(t, token, 'propose_look', {
      planId,
      name: 'Bad',
      garmentIds: [tee],
    });
    expect(one.isError).toBe(true);
    expect(await listed()).toHaveLength(before);
  });

  it('update_look rewrites a look and leaves it proposed; a sent-back one returns to the owner', async () => {
    const look = await propose([jeans, boots, wishCoat], { name: 'Weekend' });
    await reactToLooks(t.db, ownerId, planId, 'change', [
      { lookId: look.id, note: 'Warmer please' },
    ]);
    const answer = await tool<{
      id: number;
      planId: number;
      reaction: string;
      from: string;
    }>(t, token, 'update_look', {
      lookId: look.id,
      name: 'Weekend, warmer',
      garmentIds: [jeans, boots, wishCoat, wishSweater],
      occasion: 'all-day',
    });
    expect(answer).toEqual({
      id: look.id,
      planId,
      reaction: 'proposed',
      from: 'revise',
    });
    const updated = (await listed()).find((l) => l.id === look.id)!;
    expect(updated).toMatchObject({
      name: 'Weekend, warmer',
      occasion: 'all-day',
      reaction: 'proposed',
      // The owner's note stays for them to compare.
      ownerNote: 'Warmer please',
    });
    expect(updated.slots).toHaveLength(4);
    const cleared = await tool<{ from: string }>(t, token, 'update_look', {
      lookId: look.id,
      occasion: null,
      note: null,
    });
    expect(cleared.from).toBe('proposed');
  });

  it('refuses an update of a declined look and a set that is another look’s', async () => {
    const mine = await propose([jeans, boots], { name: 'Declined soon' });
    const taken = await callTool(t, token, 'update_look', {
      lookId: mine.id,
      garmentIds: [tee, boots],
    });
    expect(taken.isError).toBe(true);
    await reactToLooks(t.db, ownerId, planId, 'decline', [{ lookId: mine.id }]);
    const declined = await callTool(t, token, 'update_look', {
      lookId: mine.id,
      name: 'Again',
    });
    expect(declined.isError).toBe(true);
    const [row] = await t.db
      .select({ name: planLook.name, reaction: planLook.reaction })
      .from(planLook)
      .where(eq(planLook.id, mine.id));
    expect(row).toEqual({ name: 'Declined soon', reaction: 'declined' });
    // The declined set is never proposed again.
    const again = await callTool(t, token, 'propose_look', {
      planId,
      name: 'Retry',
      garmentIds: [boots, jeans],
    });
    expect(again.isError).toBe(true);
  });

  it('get_plan_feedback lists the looks that wait on the agent', async () => {
    const reviseMe = await propose([tee, jeans, boots], { name: 'Revise me' });
    await reactToLooks(t.db, ownerId, planId, 'change', [
      { lookId: reviseMe.id, note: 'Too plain' },
    ]);
    const broken = await propose([tee, wishCoat], { name: 'Loses its coat' });
    // A rejected candidate is deleted: the look's slot empties.
    await t.db.delete(garment).where(eq(garment.id, wishCoat));

    const feedback = await tool<Feedback>(t, token, 'get_plan_feedback', {
      planId,
    });
    expect(feedback.looks.revise).toMatchObject([
      { id: reviseMe.id, name: 'Revise me', ownerNote: 'Too plain' },
    ]);
    expect(feedback.looks.declined.map((l) => l.name)).toEqual([
      'Declined soon',
    ]);
    // The declined look carries its exact set to avoid.
    expect(
      feedback.looks.declined[0].slots.map((s) => s.garmentId).sort(),
    ).toEqual([jeans, boots].sort());
    const incomplete = feedback.looks.incomplete.find(
      (l) => l.id === broken.id,
    )!;
    expect(incomplete.missingPieces).toEqual([
      { role: 'layer', category: 'outerwear', reason: 'removed' },
    ]);
    expect(incomplete.slots).toContainEqual(
      expect.objectContaining({
        garmentId: null,
        state: 'missing',
        reason: 'removed',
      }),
    );
    expect(feedback.looks.incomplete.map((l) => l.reaction)).not.toContain(
      'declined',
    );
  });

  it('is the caller’s own: another user’s plan and look are not found', async () => {
    const look = (await listed())[0];
    for (const [name, args] of [
      ['list_looks', { planId }],
      ['propose_look', { planId, name: 'Mine now', garmentIds: [tee, jeans] }],
      ['update_look', { lookId: look.id, name: 'Mine now' }],
    ] as const) {
      const refused = await callTool(t, strangerToken, name, args);
      expect(refused, name).toEqual({
        value: {
          error: name === 'update_look' ? 'Look not found' : 'Plan not found',
        },
        isError: true,
      });
    }
    const feedback = await callTool(t, strangerToken, 'get_plan_feedback', {
      planId,
    });
    expect(feedback.value.error).toBe('Plan not found');
  });
});
