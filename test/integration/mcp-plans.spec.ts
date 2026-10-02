import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  personalAccessToken,
  planItem,
  planItemCandidate,
  wardrobePlan,
} from '../../src/db/schema';
import { createTestApp, type TestApp, unescapeHtml } from './harness';
import { callTool, createAccessToken, tool } from './mcp';

/**
 * The wardrobe plans' MCP tools (#34, slice 34a), driven like a client:
 * the style profile, the plans with their tallies, a plan's gaps as data
 * (with why an item is short), and the two writes, which leave what they
 * write proposed for the owner to accept in the app. Plans are the
 * caller's own: another user's plan or item is "not found". create_plan
 * (#269) drafts an agent's own plan, never active, marked with its token.
 */

interface GapItemOut {
  id: number;
  status: string;
  have: number;
  need: number;
  reason: string | null;
  why: string | null;
  fulfilledBy: { garmentId: number; needsRepair: boolean }[];
  replaceSoon: { garmentId: number; name: string }[];
  review: string;
  ownerNote: string | null;
  rejected: { name: string | null; reason: string | null }[];
}

interface Gaps {
  plan: {
    id: number;
    name: string;
    owned: number;
    partly: number;
    missing: number;
    proposed: number;
    revise: number;
    declined: number;
  };
  missing: GapItemOut[];
  partly: GapItemOut[];
  owned: GapItemOut[];
  proposed: { id: number; name: string | null; review: string }[];
  revise: { id: number; review: string; ownerNote: string | null }[];
  declined: { id: number; review: string; ownerNote: string | null }[];
}

describe('MCP: wardrobe plans', () => {
  let t: TestApp;
  let token: string;
  let strangerToken: string;
  let planId: number;
  let merinoId: number;

  const post = (url: string, payload: object) =>
    t.inject({ method: 'POST', url, payload });

  beforeAll(async () => {
    t = await createTestApp();
    token = await createAccessToken(t);
    const stranger = await t.register('stranger-mcp-plans@example.com');
    strangerToken = await createAccessToken(t, { cookie: stranger });
    const garment = await post('/wardrobe', {
      name: 'Grey merino',
      category: 'tops',
      type: 'sweater',
      color: 'grey',
      props: '1',
      care: '1',
      condition: 'replace_soon',
    });
    merinoId = Number(
      /\/wardrobe\/(\d+)/.exec(String(garment.headers.location))![1],
    );
    await post('/wardrobe', {
      name: 'White tee',
      category: 'tops',
      type: 't-shirt',
      color: 'white',
      props: '1',
      care: '1',
      quantity: '3',
    });
  });

  afterAll(() => t?.cleanup());

  it('reads the style profile: null until saved, then every part, and the week template with its rhythm (#16)', async () => {
    const emptyWeek = Array.from({ length: 7 }, (_, weekday) => ({
      weekday,
      day: null,
      around: [],
    }));
    expect(await tool(t, token, 'get_style_profile')).toEqual({
      profile: null,
      week: { template: emptyWeek, rhythm: [] },
    });
    await post('/auth/profile/style', {
      styles: ['minimal'],
      budget: 'premium',
      palette: ['black'],
    });
    await post('/auth/profile/week', {
      'day-1': 'work',
      'day-2': 'work',
      'around-2': ['workout', 'night-out'],
      'day-6': 'daytime',
    });
    const answer = await tool<{ week: { template: unknown[] } }>(
      t,
      token,
      'get_style_profile',
    );
    expect(answer).toEqual({
      profile: {
        styles: ['minimal'],
        budget: 'premium',
        palette: ['black'],
        notes: null,
      },
      week: {
        template: expect.any(Array),
        rhythm: [
          { occasion: 'workout', perWeek: 1 },
          { occasion: 'work', perWeek: 2 },
          { occasion: 'daytime', perWeek: 1 },
          { occasion: 'night-out', perWeek: 1 },
        ],
      },
    });
    expect(answer.week.template[2]).toEqual({
      weekday: 2,
      day: 'work',
      around: ['workout', 'night-out'],
    });
  });

  it('says there is no active plan until one exists', async () => {
    const answer = await callTool(t, token, 'get_plan_gaps');
    expect(answer.isError).toBe(true);
    expect(answer.value.error).toBe(
      'No active plan: pass a planId from list_plans',
    );
    expect(await tool(t, token, 'list_plans')).toEqual({ plans: [] });
  });

  it('lists plans with their tallies, and answers the active plan’s gaps with why', async () => {
    const created = await post('/wardrobe/plans', { name: 'Basics' });
    planId = Number(
      /\/wardrobe\/plans\/(\d+)/.exec(String(created.headers.location))![1],
    );
    for (const item of [
      { category: 'tops', type: 'sweater', colors: 'grey', priority: 'high' },
      { category: 'tops', type: 't-shirt', colors: 'white', quantity: '4' },
      { category: 'footwear', type: 'boots' },
    ]) {
      await post(`/wardrobe/plans/${planId}/items`, item);
    }
    expect(await tool(t, token, 'list_plans')).toEqual({
      plans: [
        {
          id: planId,
          name: 'Basics',
          notes: null,
          active: true,
          draftedBy: null,
          owned: 0,
          partly: 1,
          missing: 2,
          proposed: 0,
          revise: 0,
          declined: 0,
        },
      ],
    });
    const gaps = await tool<Gaps>(t, token, 'get_plan_gaps');
    expect(gaps.plan.id).toBe(planId);
    const merino = gaps.missing.find((item) => item.reason === 'replace-soon')!;
    expect(merino).toMatchObject({
      status: 'missing',
      have: 0,
      need: 1,
      replaceSoon: [{ garmentId: merinoId, name: 'Grey merino' }],
    });
    expect(merino.why).toBe(
      `no usable copy owned; Grey merino (garment ${merinoId}) is marked replace_soon (worn out) and counted as the gap to refill`,
    );
    expect(gaps.partly[0]).toMatchObject({
      have: 3,
      need: 4,
      reason: 'too-few-copies',
      why: '3 of 4 copies owned',
    });
    expect(gaps.missing.find((i) => i.reason === 'nothing-matches')?.why).toBe(
      'nothing in the closet matches',
    );
  });

  it('propose_plan_item writes a proposed item the plan does not count until the owner accepts it', async () => {
    const proposed = await tool<{
      id: number;
      planId: number;
      review: string;
    }>(t, token, 'propose_plan_item', {
      name: 'Navy blazer',
      category: 'outerwear',
      type: 'blazer',
      colors: ['blue'],
      formality: { min: 3, max: 4 },
      priority: 'high',
      budget: 299,
      note: 'Meeting Wednesdays',
    });
    expect(proposed).toMatchObject({ planId, review: 'proposed' });
    const [row] = await t.db
      .select()
      .from(planItem)
      .where(eq(planItem.id, proposed.id));
    expect(row).toMatchObject({
      name: 'Navy blazer',
      category: 'outerwear',
      type: 'blazer',
      colors: ['blue'],
      formalityMin: 3,
      formalityMax: 4,
      warmthMin: null,
      budget: '299.00',
      review: 'proposed',
    });
    const gaps = await tool<Gaps>(t, token, 'get_plan_gaps', { planId });
    expect(gaps.proposed.map((item) => item.id)).toEqual([proposed.id]);
    expect(gaps.plan).toMatchObject({ missing: 2, proposed: 1 });
    const page = await t.inject({
      method: 'GET',
      url: `/wardrobe/plans/${planId}`,
    });
    expect(page.body).toContain(
      `id="plan-item-${proposed.id}" data-status="proposed"`,
    );
    expect(t.logs.messages('info', 'Web')).toContainEqual(
      `Plan item ${proposed.id} proposed for plan ${planId} by user ${t.owner.id} (MCP)`,
    );
  });

  it('refuses an item the form would refuse, and writes nothing', async () => {
    const before = await t.db.$count(planItem);
    const wrongType = await callTool(t, token, 'propose_plan_item', {
      category: 'tops',
      type: 'jeans',
    });
    expect(wrongType.isError).toBe(true);
    expect(wrongType.value.error).toBe(
      'Choose a type of this category, or any type',
    );
    const backwards = await callTool(t, token, 'propose_plan_item', {
      category: 'tops',
      warmth: { min: 4, max: 2 },
    });
    expect(backwards.isError).toBe(true);
    expect(await t.db.$count(planItem)).toBe(before);
  });

  it('update_plan_item changes only what it is given and leaves the item proposed again', async () => {
    const gaps = await tool<Gaps>(t, token, 'get_plan_gaps');
    const tees = gaps.partly[0];
    const updated = await tool(t, token, 'update_plan_item', {
      itemId: tees.id,
      quantity: 3,
      note: 'Three is enough',
    });
    expect(updated).toEqual({ id: tees.id, planId, review: 'proposed' });
    const [row] = await t.db
      .select()
      .from(planItem)
      .where(eq(planItem.id, tees.id));
    expect(row).toMatchObject({
      category: 'tops',
      type: 't-shirt',
      colors: ['white'],
      quantity: 3,
      note: 'Three is enough',
      review: 'proposed',
    });
    // Null clears a field.
    await tool(t, token, 'update_plan_item', {
      itemId: tees.id,
      colors: [],
      note: null,
    });
    const [cleared] = await t.db
      .select()
      .from(planItem)
      .where(eq(planItem.id, tees.id));
    expect(cleared).toMatchObject({ colors: null, note: null });
    // The owner accepts it in the app: it counts again.
    await post(`/wardrobe/plans/${planId}/items/${tees.id}/accept`, {});
    const after = await tool<Gaps>(t, token, 'get_plan_gaps');
    expect(after.owned.map((item) => item.id)).toContain(tees.id);
  });

  it('keeps plans the caller’s own: another user’s plan and item are not found', async () => {
    const gaps = await callTool(t, strangerToken, 'get_plan_gaps', { planId });
    expect(gaps.value.error).toBe('Plan not found');
    const [item] = await t.db
      .select({ id: planItem.id })
      .from(planItem)
      .where(eq(planItem.planId, planId));
    const update = await callTool(t, strangerToken, 'update_plan_item', {
      itemId: item.id,
      quantity: 9,
    });
    expect(update.value.error).toBe('Plan item not found');
    const propose = await callTool(t, strangerToken, 'propose_plan_item', {
      planId,
      category: 'tops',
    });
    expect(propose.value.error).toBe('Plan not found');
    expect(await tool(t, strangerToken, 'list_plans')).toEqual({ plans: [] });
    expect(await tool(t, strangerToken, 'get_style_profile')).toMatchObject({
      profile: null,
      week: { rhythm: [] },
    });
  });

  // Last: a good grey sweater would own the Basics plan's sweater above.
  it('says why of an item partly owned beside a worn-out copy, never "only replace_soon" (#123)', async () => {
    const created = await post('/wardrobe/plans', { name: 'Knitwear' });
    const knitwear = Number(
      /\/wardrobe\/plans\/(\d+)/.exec(String(created.headers.location))![1],
    );
    await post(`/wardrobe/plans/${knitwear}/items`, {
      category: 'tops',
      type: 'sweater',
      colors: 'grey',
      quantity: '2',
      priority: 'medium',
    });
    await post('/wardrobe', {
      name: 'Grey lambswool',
      category: 'tops',
      type: 'sweater',
      color: 'grey',
      props: '1',
      care: '1',
    });
    const gaps = await tool<Gaps>(t, token, 'get_plan_gaps', {
      planId: knitwear,
    });
    expect(gaps.partly).toHaveLength(1);
    const [sweaters] = gaps.partly;
    expect(sweaters).toMatchObject({
      have: 1,
      need: 2,
      reason: 'replace-soon',
      replaceSoon: [{ garmentId: merinoId, name: 'Grey merino' }],
    });
    expect(sweaters.fulfilledBy).toHaveLength(1);
    expect(sweaters.why).toBe(
      `1 of 2 copies owned; Grey merino (garment ${merinoId}) is marked replace_soon (worn out) and counted as the gap to refill`,
    );
  });

  describe('create_plan: an agent drafts its own plan (#269)', () => {
    const DRAFTER = 'drafter-mcp-plans@example.com';
    let cookie: string;
    let muse: string;
    let museRow: { id: number; tokenPrefix: string; userId: number };
    let drafterId: number;

    beforeAll(async () => {
      cookie = await t.register(DRAFTER);
      muse = await createAccessToken(t, { cookie, name: 'Muse' });
      [museRow] = await t.db
        .select({
          id: personalAccessToken.id,
          tokenPrefix: personalAccessToken.tokenPrefix,
          userId: personalAccessToken.userId,
        })
        .from(personalAccessToken)
        .where(eq(personalAccessToken.name, 'Muse'));
      drafterId = museRow.userId;
    });

    it('drafts, proposes into and links a candidate to its own plan, which the owner sees by the token’s name', async () => {
      const created = await tool<{ id: number; name: string; active: boolean }>(
        t,
        muse,
        'create_plan',
        { name: '  Spring capsule ', notes: 'Lighter layers for April.' },
      );
      expect(created).toEqual({
        id: expect.any(Number) as number,
        name: 'Spring capsule',
        active: false,
      });
      // Never active, even as the owner's first plan.
      const [row] = await t.db
        .select()
        .from(wardrobePlan)
        .where(eq(wardrobePlan.id, created.id));
      expect(row).toMatchObject({
        ownerId: drafterId,
        name: 'Spring capsule',
        notes: 'Lighter layers for April.',
        active: false,
        draftedByTokenId: museRow.id,
      });
      expect(t.logs.messages('info', 'Web')).toContainEqual(
        `Plan ${created.id} drafted for user ${drafterId} by token ${museRow.id} (MCP)`,
      );

      // propose_plan_item takes the new plan's id unchanged.
      const proposed = await tool<{ id: number; planId: number }>(
        t,
        muse,
        'propose_plan_item',
        {
          planId: created.id,
          name: 'Light trench',
          category: 'outerwear',
          type: 'trench',
          note: 'A layer for spring rain',
        },
      );
      expect(proposed.planId).toBe(created.id);

      const wishlist = await t.inject({
        method: 'POST',
        url: '/wardrobe',
        headers: { cookie },
        payload: {
          name: 'Beige trench',
          category: 'outerwear',
          type: 'trench',
          color: 'beige',
          to: 'wishlist',
          wishlist: '1',
          props: '1',
          product: '1',
          price: '120',
          sourceUrl: 'https://shop.example/trench',
        },
      });
      const trenchId = Number(
        /\/wardrobe\/(\d+)/.exec(String(wishlist.headers.location))![1],
      );
      const candidate = await tool<{ itemId: number }>(
        t,
        muse,
        'add_candidate',
        { itemId: proposed.id, garmentId: trenchId },
      );
      expect(candidate.itemId).toBe(proposed.id);
      const links = await t.db
        .select({ garmentId: planItemCandidate.garmentId })
        .from(planItemCandidate)
        .where(eq(planItemCandidate.planItemId, proposed.id));
      expect(links).toEqual([{ garmentId: trenchId }]);

      expect(await tool(t, muse, 'list_plans')).toMatchObject({
        plans: [
          { id: created.id, active: false, draftedBy: 'Muse', proposed: 1 },
        ],
      });

      // Both pages name the token (never its prefix or hash) and count
      // its proposals.
      const page = async (url: string) => {
        const res = await t.inject({ method: 'GET', url, headers: { cookie } });
        expect(res.statusCode).toBe(200);
        return unescapeHtml(res.body);
      };
      const list = await page('/wardrobe/plans');
      const plan = await page(`/wardrobe/plans/${created.id}`);
      for (const body of [list, plan]) {
        expect(body).toContain('Drafted by Muse');
        expect(body).not.toContain(museRow.tokenPrefix);
      }
      expect(list).toContain('1 proposed by your agent');
      expect(plan).toContain('Proposed by your agent · 1');
    });

    it('refuses a name another of the owner’s plans holds, in any case, and a blank one', async () => {
      const taken = await callTool(t, muse, 'create_plan', {
        name: 'SPRING CAPSULE',
      });
      expect(taken).toEqual({
        value: { error: 'You already have a plan with this name' },
        isError: true,
      });
      const blank = await callTool(t, muse, 'create_plan', { name: '   ' });
      expect(blank).toEqual({
        value: { error: 'Give the plan a name' },
        isError: true,
      });
      const plans = await t.db
        .select({ id: wardrobePlan.id })
        .from(wardrobePlan)
        .where(eq(wardrobePlan.ownerId, drafterId));
      expect(plans).toHaveLength(1);
    });

    it('shows no drafter on the owner’s own plans', async () => {
      const page = await t.inject({ method: 'GET', url: '/wardrobe/plans' });
      expect(unescapeHtml(page.body)).not.toContain('Drafted by');
    });
  });
});
