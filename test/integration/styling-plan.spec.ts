import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garment, outfit, planItem } from '../../src/db/schema';
import { changeCandidates } from '../../src/web/plans/candidates';
import { createTestApp, type TestApp, unescapeHtml, userIdOf } from './harness';
import { HX_FRAGMENT } from './pages';

/**
 * Styling with a plan's candidates (#273): `/styling?plan=` shows the
 * owner's own plan's wishlist candidates first on their roles' strips,
 * badged "To buy"; Shuffle never draws them; a Save holding one is refused
 * with the reason and nothing stored. The statements are pinned in
 * styling-statements.spec.ts: the candidates ride in stripsReads' one.
 */
describe('Styling with a plan (#273)', () => {
  let t: TestApp;
  let ownerId: number;
  let stranger: string;
  let grantee: string;
  let planId: number;
  let strangerPlan: number;
  let tee: number;
  let jeans: number;
  /** Wishlist: a shirt (top, in a role the closet has) and boots (footwear, which it has not). */
  let shirt: number;
  let boots: number;
  let bought: number;

  const form = (payload: Record<string, string | string[]>) => {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(payload)) {
      for (const one of [value].flat()) body.append(key, one);
    }
    return {
      payload: body.toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    };
  };

  const get = (url: string, cookie?: string) =>
    t.inject({
      method: 'GET',
      url,
      headers: {
        ...(url.includes('/styling/') ? HX_FRAGMENT : {}),
        ...(cookie ? { cookie } : {}),
      },
    });

  const idOf = (location: unknown, pattern: RegExp) => {
    const match = pattern.exec(String(location));
    if (!match) throw new Error(`Unexpected redirect ${String(location)}`);
    return Number(match[1]);
  };

  const closetGarment = async (name: string, category: string) => {
    const res = await t.inject({
      method: 'POST',
      url: '/wardrobe',
      ...form({ name, category, props: '1', formality: '2', color: 'blue' }),
    });
    expect(res.statusCode).toBe(302);
    return idOf(res.headers.location, /^\/wardrobe\/(\d+)/);
  };

  const wishlistGarment = async (name: string, category: string) => {
    const res = await t.inject({
      method: 'POST',
      url: '/wardrobe',
      ...form({
        name,
        category,
        to: 'wishlist',
        wishlist: '1',
        replaces: '',
        props: '1',
        product: '1',
      }),
    });
    expect(res.statusCode, res.body).toBe(302);
    return idOf(res.headers.location, /^\/wardrobe\/(\d+)/);
  };

  /** A plan with one item per category, through the routes. */
  const planWithItems = async (cookie: string | undefined, name: string) => {
    const headers = cookie ? { cookie } : {};
    const created = await t.inject({
      method: 'POST',
      url: '/wardrobe/plans',
      payload: { name, notes: '' },
      headers,
    });
    expect(created.statusCode, created.body).toBe(303);
    const id = idOf(created.headers.location, /^\/wardrobe\/plans\/(\d+)\?/);
    for (const category of ['tops', 'footwear']) {
      const item = await t.inject({
        method: 'POST',
        url: `/wardrobe/plans/${id}/items`,
        payload: { category, quantity: '1', priority: 'medium' },
        headers,
      });
      expect(item.statusCode, item.body).toBe(303);
    }
    return id;
  };

  const itemIds = async (id: number) => {
    const rows = await t.db
      .select({ id: planItem.id, category: planItem.category })
      .from(planItem)
      .where(eq(planItem.planId, id));
    return new Map(rows.map((row) => [row.category, row.id]));
  };

  /** The garment ids a row's strip shows, in order. */
  const stripOf = (html: string, role: string): number[] => {
    const start = html.indexOf(`data-styling-row="${role}"`);
    expect(start, `a ${role} row`).toBeGreaterThan(-1);
    const end = html.indexOf('data-styling-row="', start + 1);
    return [
      ...html
        .slice(start, end === -1 ? undefined : end)
        .matchAll(/data-snap-value="(\d+)"/g),
    ].map((m) => Number(m[1]));
  };

  const rowsQuery = (
    rows: [role: string, garmentId: number | null, locked: boolean][],
    extra: Record<string, string> = {},
  ) => {
    const query = new URLSearchParams(extra);
    for (const [role, garmentId, locked] of rows) {
      query.append('role', role);
      query.append('garmentId', garmentId === null ? '' : String(garmentId));
      query.append('lock', locked ? '1' : '');
    }
    return query.toString();
  };

  beforeAll(async () => {
    t = await createTestApp();
    ownerId = await userIdOf(t, 'owner@example.com');
    tee = await closetGarment('Blue tee', 'tops');
    jeans = await closetGarment('Jeans', 'bottoms');
    shirt = await wishlistGarment('Linen shirt', 'tops');
    boots = await wishlistGarment('Chelsea boots', 'footwear');
    bought = await wishlistGarment('Bought tee', 'tops');
    planId = await planWithItems(undefined, 'Autumn');
    const items = await itemIds(planId);
    await changeCandidates(t.db, ownerId, {
      add: {
        itemIds: [items.get('tops')!],
        garmentIds: [shirt, bought],
      },
    });
    await changeCandidates(t.db, ownerId, {
      add: { itemIds: [items.get('footwear')!], garmentIds: [boots] },
    });
    // Bought since it was linked: its link stops mattering (onWishlist).
    await t.db
      .update(garment)
      .set({ status: 'closet' })
      .where(eq(garment.id, bought));

    stranger = await t.register('stranger-plan@example.com');
    strangerPlan = await planWithItems(stranger, 'Not yours');
    grantee = await t.register('grantee-plan@example.com');
    const invite = await t.inject({
      method: 'POST',
      url: '/wardrobe-share/create-invite-link',
      payload: { permission: 'VIEW' },
      headers: { 'hx-request': 'true' },
    });
    const token = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(
      invite.body,
    )![1];
    const accepted = await t.inject({
      method: 'POST',
      url: `/wardrobe-share/invite/${token}/accept`,
      payload: {},
      headers: { cookie: grantee },
    });
    expect(accepted.statusCode).toBeLessThan(400);
  });

  afterAll(() => t?.cleanup());

  describe('the page', () => {
    it('puts a candidate first on its role’s strip with a To buy badge, and a bought one in the closet', async () => {
      const page = (await get(`/styling?plan=${planId}`)).body;
      // The bought tee is newest, so it leads the closet's tops; the
      // candidate leads the strip. "No garment" is the empty value, first.
      expect(stripOf(page, 'top')).toEqual([shirt, bought, tee]);
      expect(stripOf(page, 'footwear')).toEqual([boots]);
      expect(page.match(/data-to-buy/g)).toHaveLength(2);
      expect(unescapeHtml(page)).toContain('data-styling-plan');
      // Opened on the closet's newest top, never on a piece to buy.
      expect(page).toContain(`name="garmentId" value="${bought}"`);
      expect(page).toContain('name="plan"');
    });

    it('leaves out the candidates of an item the owner declined (#278)', async () => {
      const declinedPlan = await planWithItems(undefined, 'Declined boots');
      const items = await itemIds(declinedPlan);
      const sneakers = await wishlistGarment('Sneakers', 'footwear');
      await changeCandidates(t.db, ownerId, {
        add: { itemIds: [items.get('footwear')!], garmentIds: [sneakers] },
      });
      await t.db
        .update(planItem)
        .set({ review: 'declined' })
        .where(eq(planItem.id, items.get('footwear')!));
      const page = (await get(`/styling?plan=${declinedPlan}`)).body;
      // Not on any strip: the closet has no footwear, so no row at all.
      expect(page).not.toContain(`data-snap-value="${sneakers}"`);
      expect(page).not.toContain('data-to-buy');
    });

    it('a role the closet has nothing of still gets its row, opened on No garment', async () => {
      const page = (await get(`/styling?plan=${planId}`)).body;
      const footwear = page.slice(page.indexOf('data-styling-row="footwear"'));
      expect(footwear).toContain('data-selected');
      expect(footwear).not.toMatch(/name="garmentId" value="\d/);
    });

    it('is a 404 for a plan that is not the requester’s, or unknown', async () => {
      expect((await get(`/styling?plan=${strangerPlan}`)).statusCode).toBe(404);
      expect((await get(`/styling?plan=${planId + 1000}`)).statusCode).toBe(
        404,
      );
      expect((await get(`/styling?plan=${planId}`, stranger)).statusCode).toBe(
        404,
      );
    });

    it('is ignored over a shared wardrobe, whose owner’s plans are never shared', async () => {
      const page = await get(
        `/styling?ownerId=${ownerId}&plan=${planId}`,
        grantee,
      );
      expect(page.statusCode).toBe(200);
      expect(page.body).not.toContain('data-to-buy');
      expect(page.body).not.toContain('name="plan"');
      // Even another's plan id is no 404 there: the parameter is not read.
      expect(
        (await get(`/styling?ownerId=${ownerId}&plan=${strangerPlan}`, grantee))
          .statusCode,
      ).toBe(200);
    });

    it('leaves the page without ?plan= as it was', async () => {
      const page = (await get('/styling')).body;
      expect(page).not.toContain('data-to-buy');
      expect(page).not.toContain('name="plan"');
      expect(stripOf(page, 'top')).toEqual([bought, tee]);
      expect(page).not.toContain('data-styling-row="footwear"');
    });

    it('a strip’s next page takes the plan its sentinel carries', async () => {
      const paged = await get(
        `/styling/garments?role=top&before=${tee + 1000}&plan=${planId}`,
      );
      expect(paged.statusCode).toBe(200);
    });
  });

  describe('Shuffle and "Add row"', () => {
    it('Shuffle never draws a candidate and keeps a row posted on one', async () => {
      const query = rowsQuery(
        [
          ['top', shirt, true],
          ['bottom', null, false],
          ['footwear', boots, false],
        ],
        { plan: String(planId), seed: '3' },
      );
      const res = await get(`/styling/shuffle?${query}`);
      expect(res.statusCode).toBe(200);
      // The locked candidate stays, as does its strip.
      expect(res.body).toContain(`name="garmentId" value="${shirt}"`);
      expect(stripOf(res.body, 'top')).toEqual([shirt, bought, tee]);
      // The unlocked footwear row was shuffled: nothing to wear fits it.
      expect(res.body).not.toContain(`name="garmentId" value="${boots}"`);
    });

    it('"Add row" keeps a chosen candidate', async () => {
      const query = rowsQuery([['top', shirt, false]], {
        plan: String(planId),
        add: 'footwear',
      });
      const res = await get(`/styling/row?${query}`);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(`name="garmentId" value="${shirt}"`);
      expect(stripOf(res.body, 'footwear')).toEqual([boots]);
    });

    it('both refuse a plan that is not the requester’s', async () => {
      const shuffle = rowsQuery([['top', null, false]], {
        plan: String(strangerPlan),
      });
      expect((await get(`/styling/shuffle?${shuffle}`)).statusCode).toBe(404);
      expect((await get(`/styling/row?${shuffle}`)).statusCode).toBe(404);
    });
  });

  describe('Save', () => {
    const outfits = async () =>
      (await t.db.select({ n: count() }).from(outfit))[0].n;

    it('refuses an outfit holding a piece to buy: the page again with the reason and a Bought it link, nothing stored', async () => {
      const before = await outfits();
      const res = await t.inject({
        method: 'POST',
        url: '/styling',
        ...form({
          plan: String(planId),
          role: ['top', 'bottom'],
          garmentId: [String(shirt), String(jeans)],
          lock: ['', ''],
        }),
      });
      // The refusal of every save of a piece one does not own yet (#219).
      expect(res.statusCode).toBe(409);
      const body = unescapeHtml(res.body);
      expect(body).toContain('data-styling-refused');
      expect(body).toContain('Linen shirt is on your wishlist, not bought yet');
      expect(body).toContain(`href="/wardrobe/${shirt}/bought"`);
      expect(body).toContain('Bought it: Linen shirt');
      // The page keeps the plan's strips, and the closet piece stays chosen.
      expect(stripOf(res.body, 'top')).toEqual([shirt, bought, tee]);
      expect(res.body).toContain(`name="garmentId" value="${jeans}"`);
      expect(await outfits()).toBe(before);
    });

    it('saves the same outfit once its piece is bought', async () => {
      const res = await t.inject({
        method: 'POST',
        url: '/styling',
        ...form({
          role: ['top', 'bottom'],
          garmentId: [String(tee), String(jeans)],
          lock: ['', ''],
        }),
      });
      expect(res.statusCode).toBe(303);
    });
  });
});
