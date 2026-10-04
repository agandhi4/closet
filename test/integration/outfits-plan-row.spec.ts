import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garment } from '../../src/db/schema';
import { changeCandidates } from '../../src/web/plans/candidates';
import {
  proposeLook,
  reactToLooks,
  saveLookAsOutfit,
} from '../../src/web/plans/looks';
import {
  addItems,
  createPlan,
  setActivePlan,
} from '../../src/web/plans/queries';
import type { PlanItemFields } from '../../src/web/plans/validation';
import type { GarmentStatus } from '../../src/wardrobe/status';
import {
  createTestApp,
  recordQueries,
  type TestApp,
  unescapeHtml,
  userIdOf,
} from './harness';

/**
 * The Outfits tab's "From your plan" row (#302): the signed-in user's
 * active plan's looks that are not turned down, loved first, each with its
 * Save as outfit. The tab is a stale-while-revalidate root, so its bytes
 * must not move while nothing does. The 390 px flow:
 * test/outfits-plan-row.spec.ts.
 */
describe('the Outfits tab: From your plan', () => {
  let t: TestApp;
  let seq = 0;

  const item = (category: string): PlanItemFields => ({
    name: null,
    category,
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
  });

  const newGarment = async (
    ownerId: number,
    status: GarmentStatus,
    category: string,
  ) =>
    (
      await t.db
        .insert(garment)
        .values({
          ownerId,
          status,
          category,
          name: `Piece ${++seq}`,
          shareableId: randomUUID(),
        })
        .returning({ id: garment.id })
    )[0].id;

  /**
   * A plan of `ownerId`'s with a wishlist candidate; `look` proposes one
   * over it (to buy) or, `owned`, over a closet pair of shoes (complete).
   */
  const plan = async (ownerId: number) => {
    const planId = await createPlan(t.db, ownerId, {
      name: `Row plan ${++seq}`,
      notes: null,
    });
    if (planId === 'name-taken') throw new Error('name taken');
    const [itemId] = (await addItems(
      t.db,
      ownerId,
      planId,
      [item('footwear')],
      { review: 'accepted' },
    ))!;
    const candidate = await newGarment(ownerId, 'wishlist', 'footwear');
    await changeCandidates(t.db, ownerId, {
      add: { itemIds: [itemId], garmentIds: [candidate] },
    });
    const bottom = await newGarment(ownerId, 'closet', 'bottoms');
    const look = async (name: string, owned = false) => {
      // A fresh top each: a look is one set of pieces (LookSetTaken).
      const top = await newGarment(ownerId, 'closet', 'tops');
      const shoes = owned
        ? await newGarment(ownerId, 'closet', 'footwear')
        : candidate;
      return (
        await proposeLook(
          t.db,
          ownerId,
          planId,
          { name, occasion: 'work', note: `Why ${name}` },
          [shoes, bottom, top],
        )
      ).id;
    };
    return { planId, look };
  };

  const tab = (cookie?: string) =>
    t.inject({
      method: 'GET',
      url: '/outfits',
      headers: cookie ? { cookie } : {},
    });

  const rowOf = (body: string) => {
    const html = unescapeHtml(body);
    return {
      html,
      has: html.includes('id="plan-looks"'),
      names: [...html.matchAll(/<h3[^>]*>([^<]*)<\/h3>/g)].map((m) => m[1]),
    };
  };

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  it('is not there without looks', async () => {
    const res = await tab();
    expect(res.statusCode).toBe(200);
    expect(rowOf(res.body).has).toBe(false);
    // A first plan is active; one without looks adds no row.
    await plan(t.owner.id);
    expect(rowOf((await tab()).body).has).toBe(false);
  });

  it('shows the plan page’s strip, loved first, none declined or sent back, with To buy and Save as outfit', async () => {
    const p = await plan(t.owner.id);
    const first = await p.look('First look');
    const second = await p.look('Second look');
    const loved = await p.look('Loved look');
    const declined = await p.look('Declined look');
    const ready = await p.look('Ready look', true);
    const revise = await p.look('Revise look');
    await reactToLooks(t.db, t.owner.id, p.planId, 'love', [{ lookId: loved }]);
    await reactToLooks(t.db, t.owner.id, p.planId, 'decline', [
      { lookId: declined },
    ]);
    await reactToLooks(t.db, t.owner.id, p.planId, 'change', [
      { lookId: revise, note: 'Swap the shoes' },
    ]);
    await setActivePlan(t.db, p.planId, t.owner.id);

    const { html, names } = rowOf((await tab()).body);
    expect(names).toEqual([
      'Loved look',
      'First look',
      'Second look',
      'Ready look',
    ]);
    expect(html).toContain('From your plan');
    expect(html).toContain('1 to buy');
    // Complete and not declined: the post to save it; to-buy looks offer none.
    expect(html).toContain(`data-save-look="${ready}"`);
    expect(html).not.toContain(`data-save-look="${first}"`);
    expect(html).not.toContain(`data-save-look="${second}"`);

    // Once saved, the tile links the outfit instead.
    await saveLookAsOutfit(t.db, t.owner.id, p.planId, ready);
    const saved = rowOf((await tab()).body).html;
    expect(saved).not.toContain(`data-save-look="${ready}"`);
    expect(saved).toContain('data-look-saved');
  });

  it('follows the active plan: one without looks hides the row', async () => {
    const other = await plan(t.owner.id);
    await setActivePlan(t.db, other.planId, t.owner.id);
    expect(rowOf((await tab()).body).has).toBe(false);
  });

  it('is the signed-in user’s own: a viewer of the owner’s wardrobe sees none of it', async () => {
    const mine = await plan(t.owner.id);
    await mine.look('Owner only look');
    await setActivePlan(t.db, mine.planId, t.owner.id);
    expect(rowOf((await tab()).body).names).toEqual(['Owner only look']);

    const cookie = await t.register('row-viewer@example.com');
    const viewerId = await userIdOf(t, 'row-viewer@example.com');
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
      headers: { cookie },
    });
    expect(accepted.statusCode).toBe(302);

    for (const url of ['/outfits', `/outfits?ownerId=${t.owner.id}`]) {
      const res = await t.inject({ method: 'GET', url, headers: { cookie } });
      expect(res.statusCode).toBe(200);
      expect(unescapeHtml(res.body)).not.toContain('Owner only look');
      expect(rowOf(res.body).has).toBe(false);
    }

    // The viewer's own active plan is theirs to see.
    const theirs = await plan(viewerId);
    await theirs.look('Viewer look');
    expect(rowOf((await tab(cookie)).body).names).toEqual(['Viewer look']);
  });

  it('keeps bare /outfits byte-stable while nothing changes, reading the looks in one statement', async () => {
    const p = await plan(t.owner.id);
    for (const name of ['A', 'B', 'C', 'D']) await p.look(`Stable ${name}`);
    await setActivePlan(t.db, p.planId, t.owner.id);
    const a = await tab();
    const b = await tab();
    expect(rowOf(a.body).has).toBe(true);
    expect(b.body).toBe(a.body);

    const recorded = await recordQueries(async () => {
      await tab();
    });
    // The session's, the tiles and the looks: not one more per look.
    expect(recorded.statements).toBe(3);
  });

  it('is left out while picking for a day', async () => {
    const res = await t.inject({
      method: 'GET',
      url: '/outfits?for=day:2030-01-02&occasion=work',
    });
    expect(res.statusCode).toBe(200);
    expect(rowOf(res.body).has).toBe(false);
  });
});
