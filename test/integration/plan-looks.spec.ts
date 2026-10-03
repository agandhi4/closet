import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garment, planLook, planLookSlot } from '../../src/db/schema';
import { changeCandidates } from '../../src/web/plans/candidates';
import {
  copyLooks,
  LOOKS_PER_PLAN_MAX,
  LookDeclined,
  LookNoteRequired,
  LookPiecesRefused,
  looksOfPlan,
  LookSetDeclined,
  LookSetTaken,
  proposeLook,
  reactToLooks,
  TooManyLooks,
  updateLook,
} from '../../src/web/plans/looks';
import {
  addItems,
  createPlan,
  deleteItems,
  deletePlan,
  reviewItems,
} from '../../src/web/plans/queries';
import type { PlanItemFields } from '../../src/web/plans/validation';
import { deleteGarment } from '../../src/web/wardrobe/queries';
import { buyGarment, setGarmentStatus } from '../../src/web/wardrobe/status';
import type { GarmentStatus } from '../../src/wardrobe/status';
import { createTestApp, type TestApp, userIdOf } from './harness';
import { interleave } from './interleave';

/**
 * Plan looks (#290): the writers' piece rule (a closet garment, or a
 * current candidate of an item of this plan, all the plan owner's), judged
 * under the owner lock with the garments locked FOR SHARE; every refusal;
 * the same-set rules and the cap; the agent's update and the owner's
 * reactions through the machine (every pair: src/wardrobe/look-reaction.spec.ts);
 * the derived read (to buy until Bought it, then owned; an emptied or
 * no-longer-valid slot in missingPieces with its role); the duplicate and
 * the delete. The MCP tools over them are #290's second part.
 */
describe('plan looks', () => {
  let t: TestApp;
  let strangerId: number;
  let seq = 0;

  const FIELDS = {
    name: 'Office Tuesday',
    occasion: 'work',
    note: null,
  } as const;

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

  const newPlan = async (ownerId = t.owner.id) => {
    const id = await createPlan(t.db, ownerId, {
      name: `Looks ${++seq}`,
      notes: null,
    });
    if (id === 'name-taken') throw new Error('name taken');
    return id;
  };

  const newGarment = async (
    status: GarmentStatus,
    category = 'tops',
    ownerId = t.owner.id,
  ) =>
    (
      await t.db
        .insert(garment)
        .values({
          ownerId,
          status,
          category,
          name: `Garment ${++seq}`,
          shareableId: randomUUID(),
        })
        .returning({ id: garment.id })
    )[0].id;

  /** A plan with an item and a wishlist candidate for it, plus a closet top and bottom. */
  const fixture = async () => {
    const planId = await newPlan();
    const [itemId] = (await addItems(
      t.db,
      t.owner.id,
      planId,
      [item('footwear')],
      { review: 'accepted' },
    ))!;
    const candidate = await newGarment('wishlist', 'footwear');
    await changeCandidates(t.db, t.owner.id, {
      add: { itemIds: [itemId], garmentIds: [candidate] },
    });
    const top = await newGarment('closet', 'tops');
    const bottom = await newGarment('closet', 'bottoms');
    return { planId, itemId, candidate, top, bottom };
  };

  const lookOf = async (planId: number, lookId: number) =>
    (await looksOfPlan(t.db, t.owner.id, planId)).find((l) => l.id === lookId)!;

  const refusal = async (work: Promise<unknown>) => {
    const error = await work.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    return error as Error & { statusCode: number; message: string };
  };

  beforeAll(async () => {
    t = await createTestApp();
    await t.register('looks-stranger@example.com');
    strangerId = await userIdOf(t, 'looks-stranger@example.com');
  });

  afterAll(() => t?.cleanup());

  it('stores a look of closet pieces and a candidate, slots top to toe', async () => {
    const f = await fixture();
    const proposed = await proposeLook(t.db, t.owner.id, f.planId, FIELDS, [
      f.candidate,
      f.bottom,
      f.top,
    ]);
    expect(proposed.alreadyProposed).toBe(false);
    const [row] = await t.db
      .select()
      .from(planLook)
      .where(eq(planLook.id, proposed.id));
    expect(row).toMatchObject({
      planId: f.planId,
      name: 'Office Tuesday',
      occasion: 'work',
      reaction: 'proposed',
      ownerNote: null,
    });
    expect(row.agentChangedAt).not.toBeNull();
    const slots = await t.db
      .select()
      .from(planLookSlot)
      .where(eq(planLookSlot.lookId, proposed.id))
      .orderBy(asc(planLookSlot.position));
    expect(slots.map((s) => [s.category, s.garmentId])).toEqual([
      ['tops', f.top],
      ['bottoms', f.bottom],
      ['footwear', f.candidate],
    ]);
    const look = await lookOf(f.planId, proposed.id);
    expect(look.slots.map((s) => [s.role, s.state])).toEqual([
      ['top', 'owned'],
      ['bottom', 'owned'],
      ['footwear', 'to-buy'],
    ]);
    expect(look.missingPieces).toEqual([]);
    expect(look.complete).toBe(false);
  });

  it('allows a look of closet pieces only, and two garments of one role', async () => {
    const f = await fixture();
    const second = await newGarment('closet', 'tops');
    const { id } = await proposeLook(t.db, t.owner.id, f.planId, FIELDS, [
      f.top,
      second,
      f.bottom,
    ]);
    const look = await lookOf(f.planId, id);
    expect(look.slots.map((s) => s.role)).toEqual(['top', 'top', 'bottom']);
    expect(look.complete).toBe(true);
  });

  describe('refuses a piece the look cannot hold, writing nothing', () => {
    const looksIn = async (planId: number) =>
      (await looksOfPlan(t.db, t.owner.id, planId)).length;

    it('another owner’s garment: a 404 that never names it', async () => {
      const f = await fixture();
      const theirs = await newGarment('closet', 'tops', strangerId);
      const error = await refusal(
        proposeLook(t.db, t.owner.id, f.planId, FIELDS, [f.top, theirs]),
      );
      expect(error).toBeInstanceOf(LookPiecesRefused);
      expect(error.statusCode).toBe(404);
      expect(error.message).not.toContain('Garment');
      expect(await looksIn(f.planId)).toBe(0);
    });

    it('an archived garment: a 409 naming it', async () => {
      const f = await fixture();
      const archived = await newGarment('archived', 'outerwear');
      const error = await refusal(
        proposeLook(t.db, t.owner.id, f.planId, FIELDS, [f.top, archived]),
      );
      expect(error.statusCode).toBe(409);
      expect(error.message).toMatch(/Garment \d+ is archived/);
      expect(await looksIn(f.planId)).toBe(0);
    });

    it('a wishlist item that is no candidate', async () => {
      const f = await fixture();
      const wished = await newGarment('wishlist', 'bags');
      const error = await refusal(
        proposeLook(t.db, t.owner.id, f.planId, FIELDS, [f.top, wished]),
      );
      expect(error.statusCode).toBe(409);
      expect(error.message).toContain('not a candidate of this plan');
    });

    it('a candidate of another plan', async () => {
      const f = await fixture();
      const other = await fixture();
      const error = await refusal(
        proposeLook(t.db, t.owner.id, f.planId, FIELDS, [
          f.top,
          other.candidate,
        ]),
      );
      expect(error.statusCode).toBe(409);
      expect(error.message).toContain('not a candidate of this plan');
    });

    it('a candidate of an item the owner declined', async () => {
      const f = await fixture();
      await reviewItems(t.db, t.owner.id, f.planId, 'change', [
        { itemId: f.itemId, note: 'Brown' },
      ]);
      await reviewItems(t.db, t.owner.id, f.planId, 'decline', [
        { itemId: f.itemId },
      ]);
      const error = await refusal(
        proposeLook(t.db, t.owner.id, f.planId, FIELDS, [f.top, f.candidate]),
      );
      expect(error.statusCode).toBe(409);
    });

    it('another owner’s plan is the plan’s 404', async () => {
      const f = await fixture();
      const theirs = await newPlan(strangerId);
      const error = await refusal(
        proposeLook(t.db, t.owner.id, theirs, FIELDS, [f.top, f.bottom]),
      );
      expect(error.statusCode).toBe(404);
      expect(error.message).toBe('Plan not found');
    });

    it('fewer than two pieces, a repeated one, a blank name: 400s', async () => {
      const f = await fixture();
      for (const [fields, ids] of [
        [FIELDS, [f.top]],
        [FIELDS, [f.top, f.top]],
        [{ ...FIELDS, name: '  ' }, [f.top, f.bottom]],
      ] as const) {
        const error = await refusal(
          proposeLook(t.db, t.owner.id, f.planId, fields, ids),
        );
        expect(error.statusCode).toBe(400);
      }
      const many = Array.from({ length: 21 }, (_, i) => i + 1);
      expect(
        (await refusal(proposeLook(t.db, t.owner.id, f.planId, FIELDS, many)))
          .statusCode,
      ).toBe(400);
    });
  });

  describe('exactly the same pieces', () => {
    it('a retry answers the look there, writing nothing', async () => {
      const f = await fixture();
      const first = await proposeLook(t.db, t.owner.id, f.planId, FIELDS, [
        f.top,
        f.candidate,
      ]);
      const again = await proposeLook(
        t.db,
        t.owner.id,
        f.planId,
        { ...FIELDS, name: 'Other name' },
        [f.candidate, f.top],
      );
      expect(again).toEqual({ id: first.id, alreadyProposed: true });
      expect((await lookOf(f.planId, first.id)).name).toBe('Office Tuesday');
    });

    it('a retry whose pieces no longer pass is refused as a fresh proposal', async () => {
      const f = await fixture();
      await proposeLook(t.db, t.owner.id, f.planId, FIELDS, [f.top, f.bottom]);
      await setGarmentStatus(t.db, f.bottom, t.owner.id, { event: 'archive' });
      const error = await refusal(
        proposeLook(t.db, t.owner.id, f.planId, FIELDS, [f.top, f.bottom]),
      );
      expect(error).toBeInstanceOf(LookPiecesRefused);
      expect(error.statusCode).toBe(409);
    });

    it('a declined look’s set is refused, to a proposal and to an update', async () => {
      const f = await fixture();
      const declined = await proposeLook(t.db, t.owner.id, f.planId, FIELDS, [
        f.top,
        f.bottom,
      ]);
      await reactToLooks(t.db, t.owner.id, f.planId, 'decline', [
        { lookId: declined.id, note: 'Too plain' },
      ]);
      expect(
        await refusal(
          proposeLook(t.db, t.owner.id, f.planId, FIELDS, [f.bottom, f.top]),
        ),
      ).toBeInstanceOf(LookSetDeclined);
      const other = await proposeLook(t.db, t.owner.id, f.planId, FIELDS, [
        f.top,
        f.candidate,
      ]);
      expect(
        await refusal(
          updateLook(t.db, t.owner.id, other.id, {
            garmentIds: [f.top, f.bottom],
          }),
        ),
      ).toBeInstanceOf(LookSetDeclined);
    });

    it('an update to another look’s set is refused, naming it', async () => {
      const f = await fixture();
      const a = await proposeLook(t.db, t.owner.id, f.planId, FIELDS, [
        f.top,
        f.bottom,
      ]);
      const b = await proposeLook(t.db, t.owner.id, f.planId, FIELDS, [
        f.top,
        f.candidate,
      ]);
      const error = await refusal(
        updateLook(t.db, t.owner.id, b.id, { garmentIds: [f.bottom, f.top] }),
      );
      expect(error).toBeInstanceOf(LookSetTaken);
      expect(error.message).toContain(`Look ${a.id}`);
    });
  });

  it(`holds at most ${LOOKS_PER_PLAN_MAX} looks not declined`, async () => {
    const f = await fixture();
    const closet = await Promise.all(
      Array.from({ length: LOOKS_PER_PLAN_MAX }, () => newGarment('closet')),
    );
    const ids: number[] = [];
    for (const piece of closet) {
      ids.push(
        (await proposeLook(t.db, t.owner.id, f.planId, FIELDS, [f.top, piece]))
          .id,
      );
    }
    const extra = await newGarment('closet');
    expect(
      await refusal(
        proposeLook(t.db, t.owner.id, f.planId, FIELDS, [f.bottom, extra]),
      ),
    ).toBeInstanceOf(TooManyLooks);
    // "Not for me" frees a place.
    await reactToLooks(t.db, t.owner.id, f.planId, 'decline', [
      { lookId: ids[0] },
    ]);
    await proposeLook(t.db, t.owner.id, f.planId, FIELDS, [f.bottom, extra]);
    // Back at the cap, Reconsider is refused whole: nothing moves.
    const error = await refusal(
      reactToLooks(t.db, t.owner.id, f.planId, 'reconsider', [
        { lookId: ids[0] },
      ]),
    );
    expect(error).toBeInstanceOf(TooManyLooks);
    expect(error.statusCode).toBe(409);
    expect((await lookOf(f.planId, ids[0])).reaction).toBe('declined');
  });

  describe('the agent’s update and the owner’s reactions', () => {
    it('a revise or loved look goes back to proposed, the owner’s note kept; a declined one is refused', async () => {
      const f = await fixture();
      const { id } = await proposeLook(t.db, t.owner.id, f.planId, FIELDS, [
        f.top,
        f.candidate,
      ]);
      await reactToLooks(t.db, t.owner.id, f.planId, 'change', [
        { lookId: id, note: 'Darker shoes' },
      ]);
      expect(
        await updateLook(t.db, t.owner.id, id, {
          name: 'Office, darker',
          occasion: null,
        }),
      ).toEqual({ planId: f.planId, from: 'revise', to: 'proposed' });
      expect(await lookOf(f.planId, id)).toMatchObject({
        name: 'Office, darker',
        occasion: null,
        reaction: 'proposed',
        ownerNote: 'Darker shoes',
      });
      await reactToLooks(t.db, t.owner.id, f.planId, 'love', [{ lookId: id }]);
      expect((await lookOf(f.planId, id)).ownerNote).toBeNull();
      expect(
        await updateLook(t.db, t.owner.id, id, {
          garmentIds: [f.top, f.bottom, f.candidate],
        }),
      ).toMatchObject({ from: 'loved', to: 'proposed' });
      expect(
        (await lookOf(f.planId, id)).slots.map((s) => s.garmentId),
      ).toEqual([f.top, f.bottom, f.candidate]);
      await reactToLooks(t.db, t.owner.id, f.planId, 'decline', [
        { lookId: id },
      ]);
      expect(
        await refusal(updateLook(t.db, t.owner.id, id, { name: 'Again' })),
      ).toBeInstanceOf(LookDeclined);
      const reconsidered = await reactToLooks(
        t.db,
        t.owner.id,
        f.planId,
        'reconsider',
        [{ lookId: id }],
      );
      expect(reconsidered).toEqual({ moved: [id], refused: [] });
    });

    it('Change this needs a note: missing or blank is a 400 with nothing written; notes are stored trimmed', async () => {
      const f = await fixture();
      const { id } = await proposeLook(t.db, t.owner.id, f.planId, FIELDS, [
        f.top,
        f.bottom,
      ]);
      for (const note of [undefined, '   ']) {
        const error = await refusal(
          reactToLooks(t.db, t.owner.id, f.planId, 'change', [
            { lookId: id, note },
          ]),
        );
        expect(error).toBeInstanceOf(LookNoteRequired);
        expect(error.statusCode).toBe(400);
        expect(await lookOf(f.planId, id)).toMatchObject({
          reaction: 'proposed',
          ownerNote: null,
        });
      }
      await reactToLooks(t.db, t.owner.id, f.planId, 'change', [
        { lookId: id, note: '  Brighter top  ' },
      ]);
      expect((await lookOf(f.planId, id)).ownerNote).toBe('Brighter top');
      await reactToLooks(t.db, t.owner.id, f.planId, 'decline', [
        { lookId: id, note: '   ' },
      ]);
      expect(await lookOf(f.planId, id)).toMatchObject({
        reaction: 'declined',
        ownerNote: null,
      });
    });

    it('refuses a move the reaction does not take, and leaves another plan’s look out', async () => {
      const f = await fixture();
      const { id } = await proposeLook(t.db, t.owner.id, f.planId, FIELDS, [
        f.top,
        f.bottom,
      ]);
      expect(
        await reactToLooks(t.db, t.owner.id, f.planId, 'reconsider', [
          { lookId: id },
        ]),
      ).toEqual({ moved: [], refused: [{ lookId: id, reaction: 'proposed' }] });
      const other = await newPlan();
      expect(
        await reactToLooks(t.db, t.owner.id, other, 'love', [{ lookId: id }]),
      ).toEqual({ moved: [], refused: [] });
      expect(
        await reactToLooks(t.db, strangerId, f.planId, 'love', [
          { lookId: id },
        ]),
      ).toEqual({ moved: [], refused: [] });
    });

    it('another owner’s look is not found to an update', async () => {
      const f = await fixture();
      const { id } = await proposeLook(t.db, t.owner.id, f.planId, FIELDS, [
        f.top,
        f.bottom,
      ]);
      const error = await refusal(
        updateLook(t.db, strangerId, id, { name: 'Mine' }),
      );
      expect(error.statusCode).toBe(404);
      expect(error.message).toBe('Look not found');
      expect(await looksOfPlan(t.db, strangerId, f.planId)).toEqual([]);
    });
  });

  describe('what each piece is, derived on read', () => {
    it('a candidate is to buy until Bought it, then owned', async () => {
      const f = await fixture();
      const { id } = await proposeLook(t.db, t.owner.id, f.planId, FIELDS, [
        f.top,
        f.candidate,
      ]);
      expect((await lookOf(f.planId, id)).complete).toBe(false);
      await buyGarment(t.db, f.candidate, t.owner.id, {
        acquiredOn: null,
        price: null,
        archiveReplaced: false,
      });
      const look = await lookOf(f.planId, id);
      expect(look.slots.map((s) => s.state)).toEqual(['owned', 'owned']);
      expect(look.complete).toBe(true);
    });

    it('a deleted candidate empties its slot: missing, with its role', async () => {
      const f = await fixture();
      const { id } = await proposeLook(t.db, t.owner.id, f.planId, FIELDS, [
        f.top,
        f.candidate,
      ]);
      await deleteGarment(t.db, f.candidate, t.owner.id);
      const look = await lookOf(f.planId, id);
      expect(look.missingPieces).toEqual([
        expect.objectContaining({
          role: 'footwear',
          category: 'footwear',
          garmentId: null,
          state: 'missing',
          reason: 'removed',
        }),
      ]);
      expect(look.complete).toBe(false);
    });

    it('an unlinked candidate, a deleted or declined item’s, and an archived garment are missing', async () => {
      const f = await fixture();
      const { id } = await proposeLook(t.db, t.owner.id, f.planId, FIELDS, [
        f.top,
        f.candidate,
      ]);
      const reasons = async () =>
        (await lookOf(f.planId, id)).missingPieces.map((s) => s.reason);
      await changeCandidates(t.db, t.owner.id, {
        remove: { itemIds: [f.itemId], garmentIds: [f.candidate] },
      });
      expect(await reasons()).toEqual(['not-a-candidate']);
      await changeCandidates(t.db, t.owner.id, {
        add: { itemIds: [f.itemId], garmentIds: [f.candidate] },
      });
      expect(await reasons()).toEqual([]);
      await reviewItems(t.db, t.owner.id, f.planId, 'change', [
        { itemId: f.itemId, note: 'Other' },
      ]);
      await reviewItems(t.db, t.owner.id, f.planId, 'decline', [
        { itemId: f.itemId },
      ]);
      expect(await reasons()).toEqual(['not-a-candidate']);
      await deleteItems(t.db, [f.itemId], f.planId, t.owner.id);
      expect(await reasons()).toEqual(['not-a-candidate']);
      await setGarmentStatus(t.db, f.top, t.owner.id, { event: 'archive' });
      expect(await reasons()).toEqual(['archived', 'not-a-candidate']);
    });
  });

  it('the duplicate copies every look, reaction, notes and slots, its pieces still valid', async () => {
    const f = await fixture();
    const kept = await proposeLook(t.db, t.owner.id, f.planId, FIELDS, [
      f.top,
      f.candidate,
    ]);
    const declined = await proposeLook(t.db, t.owner.id, f.planId, FIELDS, [
      f.top,
      f.bottom,
    ]);
    await reactToLooks(t.db, t.owner.id, f.planId, 'decline', [
      { lookId: declined.id, note: 'Plain' },
    ]);
    const res = await t.inject({
      method: 'POST',
      url: `/wardrobe/plans/${f.planId}/duplicate`,
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(303);
    const copyId = Number(
      /plans\/(\d+)/.exec(String(res.headers.location))![1],
    );
    const shape = (looks: Awaited<ReturnType<typeof looksOfPlan>>) =>
      looks.map((l) => ({
        name: l.name,
        reaction: l.reaction,
        ownerNote: l.ownerNote,
        slots: l.slots.map((s) => [s.garmentId, s.state]),
      }));
    const copied = await looksOfPlan(t.db, t.owner.id, copyId);
    expect(shape(copied)).toEqual(
      shape(await looksOfPlan(t.db, t.owner.id, f.planId)),
    );
    expect(copied[0].slots.map((s) => s.state)).toEqual(['owned', 'to-buy']);
    expect(copied.map((l) => l.id)).not.toContain(kept.id);
    // The declined set stays remembered in the copy.
    expect(
      await refusal(
        proposeLook(t.db, t.owner.id, copyId, FIELDS, [f.top, f.bottom]),
      ),
    ).toBeInstanceOf(LookSetDeclined);
    // Nothing to copy: no statement past the read.
    const empty = await newPlan();
    expect(await copyLooks(t.db, empty, await newPlan())).toBe(0);
  });

  it('deleting the plan deletes its looks and their slots', async () => {
    const f = await fixture();
    const { id } = await proposeLook(t.db, t.owner.id, f.planId, FIELDS, [
      f.top,
      f.bottom,
    ]);
    expect(await deletePlan(t.db, f.planId, t.owner.id)).toBe(true);
    expect(
      await t.db.select().from(planLook).where(eq(planLook.id, id)),
    ).toEqual([]);
    expect(
      await t.db.select().from(planLookSlot).where(eq(planLookSlot.lookId, id)),
    ).toEqual([]);
  });

  describe('concurrency', () => {
    it('a proposal waiting on a decline under the owner lock is refused the declined item’s candidate', async () => {
      const f = await fixture();
      await reviewItems(t.db, t.owner.id, f.planId, 'change', [
        { itemId: f.itemId, note: 'Other' },
      ]);
      const [, proposal] = await interleave(
        t.db,
        (tx) =>
          reviewItems(tx, t.owner.id, f.planId, 'decline', [
            { itemId: f.itemId },
          ]),
        () =>
          proposeLook(t.db, t.owner.id, f.planId, FIELDS, [
            f.top,
            f.candidate,
          ]).then(
            () => undefined,
            (error: unknown) => error,
          ),
      );
      expect(proposal).toBeInstanceOf(LookPiecesRefused);
      expect(await looksOfPlan(t.db, t.owner.id, f.planId)).toEqual([]);
    });

    it('a garment delete waits for the proposal holding it, then empties its slot', async () => {
      const f = await fixture();
      const [proposed] = await interleave(
        t.db,
        (tx) =>
          proposeLook(tx, t.owner.id, f.planId, FIELDS, [f.top, f.candidate]),
        () => deleteGarment(t.db, f.candidate, t.owner.id),
      );
      const look = await lookOf(f.planId, proposed.id);
      expect(look.missingPieces.map((s) => [s.role, s.reason])).toEqual([
        ['footwear', 'removed'],
      ]);
    });
  });
});
