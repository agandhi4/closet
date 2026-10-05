import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garment, outfit, outfitSlot, planLook } from '../../src/db/schema';
import { createOutfit, deleteOutfit } from '../../src/web/outfits/queries';
import { changeCandidates } from '../../src/web/plans/candidates';
import {
  looksOfPlan,
  proposeLook,
  reactToLooks,
  saveLookAsOutfit,
  updateLook,
} from '../../src/web/plans/looks';
import { addItems, createPlan } from '../../src/web/plans/queries';
import type { PlanItemFields } from '../../src/web/plans/validation';
import { deleteGarment } from '../../src/web/wardrobe/queries';
import { setGarmentStatus } from '../../src/web/wardrobe/status';
import type { GarmentStatus } from '../../src/wardrobe/status';
import { recordStatements } from '../support/query-recorder';
import { createTestApp, type TestApp, unescapeHtml } from './harness';
import { interleave } from './interleave';
import { createAccessToken, tool } from './mcp';
import { expectFullPage } from './pages';

/**
 * Looks become outfits (#292): Save as outfit on a look whose every piece
 * is owned (through createOutfit, idempotently, under the owner lock), the
 * link it leaves (plan_look.outfit_id: cleared by the outfit's delete and
 * by an agent's new set of pieces, never changing the outfit), the Bought
 * it result listing the looks a purchase completed, "In N looks" on the
 * candidate strips, and list_looks' outfitId. The matrix row is in
 * authorization-plans.spec.ts; the 390 px flow, test/look-to-outfit.spec.ts.
 */
describe('looks become outfits', () => {
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

  const newGarment = async (status: GarmentStatus, category: string) =>
    (
      await t.db
        .insert(garment)
        .values({
          ownerId: t.owner.id,
          status,
          category,
          name: `Piece ${++seq}`,
          shareableId: randomUUID(),
        })
        .returning({ id: garment.id })
    )[0].id;

  /**
   * A plan with an item (`review`) and a wishlist candidate for it, a
   * closet top and bottom; `look()` proposes a look of the three.
   */
  const fixture = async (
    review: 'accepted' | 'proposed' = 'accepted',
    // The item's and its candidate's category: a fresh one keeps the
    // closet the other tests filled from fulfilling the item.
    category = 'footwear',
  ) => {
    const planId = await createPlan(t.db, t.owner.id, {
      name: `Outfits ${++seq}`,
      notes: null,
    });
    if (planId === 'name-taken') throw new Error('name taken');
    const [itemId] = (await addItems(
      t.db,
      t.owner.id,
      planId,
      [item(category)],
      { review },
    ))!;
    const candidate = await newGarment('wishlist', category);
    await changeCandidates(t.db, t.owner.id, {
      add: { itemIds: [itemId], garmentIds: [candidate] },
    });
    const top = await newGarment('closet', 'tops');
    const bottom = await newGarment('closet', 'bottoms');
    const look = async (
      name = `Look ${++seq}`,
      garmentIds = [candidate, bottom, top],
    ) =>
      (
        await proposeLook(
          t.db,
          t.owner.id,
          planId,
          { name, occasion: 'work', note: `  Why ${name} works ` },
          garmentIds,
        )
      ).id;
    return { planId, itemId, candidate, top, bottom, look };
  };

  const save = (planId: number, lookId: number) =>
    t.inject({
      method: 'POST',
      url: `/wardrobe/plans/${planId}/looks/${lookId}/save`,
      payload: {},
    });

  const buy = (garmentId: number) =>
    setGarmentStatus(t.db, garmentId, t.owner.id, {
      event: 'buy',
      acquiredOn: null,
      price: null,
    });

  const linkOf = async (lookId: number) =>
    (
      await t.db
        .select({ outfitId: planLook.outfitId })
        .from(planLook)
        .where(eq(planLook.id, lookId))
    )[0].outfitId;

  const outfitsOf = async () =>
    (
      await t.db
        .select({ id: outfit.id })
        .from(outfit)
        .where(eq(outfit.ownerId, t.owner.id))
    ).map((row) => row.id);

  const outfitIdIn = (location: unknown) =>
    Number(/^\/outfits\/(\d+)/.exec(String(location))![1]);

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t?.cleanup());

  describe('Save as outfit', () => {
    it('is refused while a piece is still to buy, nothing written', async () => {
      const f = await fixture();
      const lookId = await f.look();
      const before = await outfitsOf();
      const res = await save(f.planId, lookId);
      expect(res.statusCode).toBe(409);
      expect(unescapeHtml(res.body)).toContain('is still to buy');
      expect(await linkOf(lookId)).toBeNull();
      expect(await outfitsOf()).toEqual(before);
    });

    it('is refused while a piece is missing (its candidate deleted)', async () => {
      const f = await fixture();
      const lookId = await f.look();
      await deleteGarment(t.db, f.candidate, t.owner.id);
      const res = await save(f.planId, lookId);
      expect(res.statusCode).toBe(409);
      expect(unescapeHtml(res.body)).toContain('a piece is missing');
      expect(await linkOf(lookId)).toBeNull();
    });

    it('is refused on a declined look, whose pieces are all owned', async () => {
      const f = await fixture();
      const lookId = await f.look();
      await buy(f.candidate);
      await reactToLooks(t.db, t.owner.id, f.planId, 'decline', [{ lookId }]);
      const res = await save(f.planId, lookId);
      expect(res.statusCode).toBe(409);
      expect(await linkOf(lookId)).toBeNull();
    });

    it('creates the outfit slot for slot, named after the look, and links it; a second post answers the same', async () => {
      const f = await fixture();
      const lookId = await f.look('Office Tuesday');
      await buy(f.candidate);
      const before = (await outfitsOf()).length;

      const { result: res, statements } = await recordStatements(() =>
        save(f.planId, lookId),
      );
      expect(res.statusCode, res.body).toBe(303);
      // The session, begin, the owner lock, the look, the outfit, its
      // slots, the link, commit.
      expect(statements).toHaveLength(8);
      const outfitId = outfitIdIn(res.headers.location);
      expect(res.headers.location).toBe(`/outfits/${outfitId}`);
      expect(await linkOf(lookId)).toBe(outfitId);

      const [saved] = await t.db
        .select({ name: outfit.name, notes: outfit.notes })
        .from(outfit)
        .where(eq(outfit.id, outfitId));
      expect(saved).toEqual({
        name: 'Office Tuesday',
        notes: 'Why Office Tuesday works',
      });
      const slots = await t.db
        .select({
          position: outfitSlot.position,
          category: outfitSlot.category,
          garmentId: outfitSlot.garmentId,
        })
        .from(outfitSlot)
        .where(eq(outfitSlot.outfitId, outfitId))
        .orderBy(asc(outfitSlot.position));
      const look = (await looksOfPlan(t.db, t.owner.id, f.planId)).find(
        (l) => l.id === lookId,
      )!;
      expect(slots).toEqual(
        look.slots.map(({ position, category, garmentId }) => ({
          position,
          category,
          garmentId,
        })),
      );

      const again = await save(f.planId, lookId);
      expect(again.statusCode).toBe(303);
      expect(again.headers.location).toBe(
        `/outfits/${outfitId}?alreadySaved=1`,
      );
      expect((await outfitsOf()).length).toBe(before + 1);

      // The plan page links the outfit it became; Save is not offered.
      const page = unescapeHtml(
        (
          await t.inject({
            method: 'GET',
            url: `/wardrobe/plans/${f.planId}?view=outfits`,
          })
        ).body,
      );
      expect(page).toContain(`href="/outfits/${outfitId}"`);
      expect(page).not.toContain(`/looks/${lookId}/save"`);
    });

    it("a second save waiting on the owner lock finds the first one's outfit", async () => {
      const f = await fixture();
      const lookId = await f.look();
      await buy(f.candidate);
      const before = (await outfitsOf()).length;
      const [first, second] = await interleave(
        t.db,
        (tx) => saveLookAsOutfit(tx, t.owner.id, f.planId, lookId),
        () => saveLookAsOutfit(t.db, t.owner.id, f.planId, lookId),
      );
      if (first === 'not-found' || second === 'not-found') {
        throw new Error('look not found');
      }
      expect(second).toEqual({ outfitId: first.outfitId, alreadySaved: true });
      expect((await outfitsOf()).length).toBe(before + 1);
    });

    it('links an outfit the owner already has of these pieces, its name kept', async () => {
      const f = await fixture();
      const lookId = await f.look('Agent name');
      await buy(f.candidate);
      const look = (await looksOfPlan(t.db, t.owner.id, f.planId)).find(
        (l) => l.id === lookId,
      )!;
      const existing = await createOutfit(t.db, t.owner.id, {
        name: 'Mine already',
        slots: look.slots.map(({ category, garmentId }) => ({
          category,
          garmentId,
        })),
      });
      const res = await save(f.planId, lookId);
      expect(res.headers.location).toBe(
        `/outfits/${existing.id}?alreadySaved=1`,
      );
      expect(await linkOf(lookId)).toBe(existing.id);
      const [kept] = await t.db
        .select({ name: outfit.name })
        .from(outfit)
        .where(eq(outfit.id, existing.id));
      expect(kept.name).toBe('Mine already');
    });

    it('a look sent back to the agent is saveable as it is', async () => {
      const f = await fixture();
      const lookId = await f.look();
      await buy(f.candidate);
      await reactToLooks(t.db, t.owner.id, f.planId, 'change', [
        { lookId, note: 'Warmer' },
      ]);
      expect((await save(f.planId, lookId)).statusCode).toBe(303);
    });

    it('a look of another plan of the owner is a 404', async () => {
      const f = await fixture();
      const other = await fixture();
      const lookId = await other.look();
      expect((await save(f.planId, lookId)).statusCode).toBe(404);
    });
  });

  describe('the link', () => {
    const savedLook = async () => {
      const f = await fixture();
      const lookId = await f.look();
      await buy(f.candidate);
      const outfitId = outfitIdIn(
        (await save(f.planId, lookId)).headers.location,
      );
      return { ...f, lookId, outfitId };
    };

    it('a deleted outfit clears it, and the look offers Save again', async () => {
      const f = await savedLook();
      await deleteOutfit(t.db, f.outfitId, t.owner.id);
      expect(await linkOf(f.lookId)).toBeNull();
      const page = unescapeHtml(
        (
          await t.inject({
            method: 'GET',
            url: `/wardrobe/plans/${f.planId}?view=outfits`,
          })
        ).body,
      );
      expect(page).toContain(`/looks/${f.lookId}/save"`);
      const again = await save(f.planId, f.lookId);
      expect(again.statusCode).toBe(303);
      expect(outfitIdIn(again.headers.location)).not.toBe(f.outfitId);
    });

    it("an agent's new set of pieces clears it and never changes the outfit; a name edit keeps it", async () => {
      const f = await savedLook();
      const slotsOf = async () =>
        (
          await t.db
            .select({ garmentId: outfitSlot.garmentId })
            .from(outfitSlot)
            .where(eq(outfitSlot.outfitId, f.outfitId))
            .orderBy(asc(outfitSlot.position))
        ).map((row) => row.garmentId);
      const slots = await slotsOf();

      await updateLook(t.db, t.owner.id, f.lookId, { name: 'Renamed' });
      expect(await linkOf(f.lookId)).toBe(f.outfitId);
      const [named] = await t.db
        .select({ name: outfit.name })
        .from(outfit)
        .where(eq(outfit.id, f.outfitId));
      expect(named.name).not.toBe('Renamed');

      const shoes = await newGarment('closet', 'footwear');
      await updateLook(t.db, t.owner.id, f.lookId, {
        garmentIds: [f.top, f.bottom, shoes],
      });
      expect(await linkOf(f.lookId)).toBeNull();
      expect(await slotsOf()).toEqual(slots);
    });

    it('a piece archived after the save keeps it; the look shows the outfit', async () => {
      const f = await savedLook();
      await setGarmentStatus(t.db, f.top, t.owner.id, { event: 'archive' });
      expect(await linkOf(f.lookId)).toBe(f.outfitId);
      const res = await save(f.planId, f.lookId);
      expect(res.headers.location).toBe(
        `/outfits/${f.outfitId}?alreadySaved=1`,
      );
    });

    it('list_looks reports outfitId', async () => {
      const f = await savedLook();
      const token = await createAccessToken(t, { name: `Agent ${++seq}` });
      const { looks } = await tool<{
        looks: { id: number; outfitId: number | null }[];
      }>(t, token, 'list_looks', { planId: f.planId });
      expect(looks.find((l) => l.id === f.lookId)?.outfitId).toBe(f.outfitId);
    });
  });

  describe('after Bought it', () => {
    it('the result page lists the looks the purchase completed, with Save as outfit', async () => {
      const f = await fixture();
      const completes = await f.look('Completes');
      const stillShort = await newGarment('wishlist', 'outerwear');
      const otherItem = (await addItems(
        t.db,
        t.owner.id,
        f.planId,
        [item('outerwear')],
        { review: 'accepted' },
      ))![0];
      await changeCandidates(t.db, t.owner.id, {
        add: { itemIds: [otherItem], garmentIds: [stillShort] },
      });
      const short = await f.look('Still short', [
        f.candidate,
        f.top,
        stillShort,
      ]);
      const declined = await f.look('Declined', [f.candidate, f.bottom]);
      await reactToLooks(t.db, t.owner.id, f.planId, 'decline', [
        { lookId: declined },
      ]);

      const bought = await t.inject({
        method: 'POST',
        url: `/wardrobe/${f.candidate}/bought`,
        payload: { acquiredOn: t.today(), price: '' },
      });
      expect(bought.statusCode, bought.body).toBe(303);
      const location = String(bought.headers.location);
      expect(location).toContain('bought=1');
      const page = await t.inject({ method: 'GET', url: location });
      expect(page.statusCode).toBe(200);
      expectFullPage(page);
      const html = unescapeHtml(page.body);
      expect(html).toContain('id="completed-looks"');
      expect(html).toContain(`id="completed-look-${completes}"`);
      expect(html).toContain(
        `action="/wardrobe/plans/${f.planId}/looks/${completes}/save"`,
      );
      expect(html).not.toContain(`id="completed-look-${short}"`);
      expect(html).not.toContain(`id="completed-look-${declined}"`);

      // Not on the garment's own page without the flag.
      const plain = await t.inject({
        method: 'GET',
        url: `/wardrobe/${f.candidate}`,
      });
      expect(plain.body).not.toContain('id="completed-looks"');
    });

    it("shows a MANAGE grantee who buys the piece no completed looks and no Save as outfit: looks are the owner's", async () => {
      const f = await fixture();
      await f.look('Completes');
      const cookie = await t.register('look-manager@example.com');
      const invite = await t.inject({
        method: 'POST',
        url: '/wardrobe-share/create-invite-link',
        payload: { permission: 'MANAGE' },
        headers: { 'hx-request': 'true' },
      });
      const token = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(
        invite.body,
      )![1];
      await t.inject({
        method: 'POST',
        url: `/wardrobe-share/invite/${token}/accept`,
        headers: { cookie },
      });

      const bought = await t.inject({
        method: 'POST',
        url: `/wardrobe/${f.candidate}/bought?ownerId=${t.owner.id}`,
        payload: { acquiredOn: t.today(), price: '' },
        headers: { cookie },
      });
      expect(bought.statusCode, bought.body).toBe(303);
      const location = String(bought.headers.location);
      expect(location).toContain('bought=1');
      const page = await t.inject({
        method: 'GET',
        url: location,
        headers: { cookie },
      });
      expect(page.statusCode).toBe(200);
      const html = unescapeHtml(page.body);
      expect(html).not.toContain('id="completed-looks"');
      expect(html).not.toContain('/save"');
    });
  });

  describe('"In N looks" on the candidate strips', () => {
    it("counts the plan's looks holding a candidate, declined aside, loved apart", async () => {
      const f = await fixture('proposed');
      const loved = await f.look('Loved');
      await f.look('Proposed', [f.candidate, f.top]);
      const declined = await f.look('Declined', [f.candidate, f.bottom]);
      await reactToLooks(t.db, t.owner.id, f.planId, 'love', [
        { lookId: loved },
      ]);
      await reactToLooks(t.db, t.owner.id, f.planId, 'decline', [
        { lookId: declined },
      ]);
      const review = unescapeHtml(
        (
          await t.inject({
            method: 'GET',
            url: `/wardrobe/plans/${f.planId}/review`,
          })
        ).body,
      );
      expect(review).toContain('data-in-looks="2" data-loved-looks="1"');
      expect(review).toContain('In 2 looks, 1 loved');
    });

    it('shows on the shopping list, and nothing for a candidate in no look', async () => {
      const category = `boots-${++seq}`;
      const f = await fixture('accepted', category);
      await f.look();
      const lonely = await newGarment('wishlist', category);
      await changeCandidates(t.db, t.owner.id, {
        add: { itemIds: [f.itemId], garmentIds: [lonely] },
      });
      const html = unescapeHtml(
        (
          await t.inject({
            method: 'GET',
            url: `/wardrobe/shopping?plan=${f.planId}`,
          })
        ).body,
      );
      expect(html).toContain('data-in-looks="1" data-loved-looks="0"');
      expect(html).toContain('In 1 look');
      expect(html.match(/data-in-looks=/g)).toHaveLength(1);
    });
  });

  it('the review page says a saved look is saved, without a post of its own', async () => {
    const f = await fixture('proposed');
    const lookId = await f.look('Closet only', [f.top, f.bottom]);
    const ready = unescapeHtml(
      (
        await t.inject({
          method: 'GET',
          url: `/wardrobe/plans/${f.planId}/review`,
        })
      ).body,
    );
    expect(ready).toContain('data-look-save-state="saveable"');
    expect(ready).not.toContain(`/looks/${lookId}/save"`);
    expect((await save(f.planId, lookId)).statusCode).toBe(303);
    const saved = unescapeHtml(
      (
        await t.inject({
          method: 'GET',
          url: `/wardrobe/plans/${f.planId}/review`,
        })
      ).body,
    );
    expect(saved).toContain('data-look-save-state="saved"');
  });

  it('the duplicate keeps the link', async () => {
    const f = await fixture();
    const lookId = await f.look();
    await buy(f.candidate);
    const outfitId = outfitIdIn(
      (await save(f.planId, lookId)).headers.location,
    );
    const res = await t.inject({
      method: 'POST',
      url: `/wardrobe/plans/${f.planId}/duplicate`,
      payload: {},
    });
    const copyId = Number(
      /plans\/(\d+)/.exec(String(res.headers.location))![1],
    );
    const copies = await looksOfPlan(t.db, t.owner.id, copyId);
    expect(copies.map((l) => l.outfitId)).toEqual([outfitId]);
  });
});
