import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Queryable } from '../../src/db/client';
import {
  garment,
  outfit,
  outfitCalendar,
  outfitSlot,
  weekPlan,
  weekReplan,
} from '../../src/db/schema';
import type { Occasion } from '../../src/wardrobe/occasions';
import { lockOwner, lockOwnerQuery } from '../../src/web/auth/queries';
import { addDays, type IsoDate } from '../../src/web/calendar/calendar-date';
import { deleteEntry, scheduleOutfit } from '../../src/web/calendar/queries';
import {
  replaceEntryOutfit,
  replaceMessage,
} from '../../src/web/calendar/replace';
import { pickIdea } from '../../src/web/gallery/ideas';
import { deleteGarment } from '../../src/web/wardrobe/queries';
import { setGarmentStatus } from '../../src/web/wardrobe/status';
import {
  createWeekPlan,
  recordAutoEntry,
} from '../../src/web/week-plan/queries';
import { type ReplanDeps, replanToday } from '../../src/web/week-plan/replan';
import { createTestApp, type TestApp } from './harness';
import { interleave as interleaveOn } from './interleave';

/**
 * The owner lock (#122, src/web/calendar/CLAUDE.md): every writer of the
 * calendar and the plan tables runs in ownerTransaction, so a write that
 * judges several rows (a replace, the daily re-plan) never has another of
 * the owner's writes land between its read and its write; and a pick holds
 * its garments until its outfit is saved. Each case holds one writer's
 * transaction open, proves the other waits on it, then lets the first
 * commit: the second must find what the first did, whichever goes first.
 */

type Fields = Record<string, string | string[]>;

function formPayload(fields: Fields) {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of [value].flat()) body.append(name, item);
  }
  return {
    payload: body.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  };
}

/** A node of EXPLAIN (VERBOSE, FORMAT JSON)'s plan. */
interface PlanNode {
  'Node Type': string;
  Output?: string[];
  Plans?: PlanNode[];
}

describe('the owner lock', () => {
  let t: TestApp;
  let tops: number[];
  let bottoms: number[];
  let shoes: number[];

  const garmentIn = async (name: string, category: string, color: string) => {
    const res = await t.inject({
      method: 'POST',
      url: '/wardrobe',
      ...formPayload({
        name,
        category,
        props: '1',
        formality: '2',
        pattern: 'solid',
        color: [color],
      }),
    });
    expect(res.statusCode).toBe(302);
    return Number(
      /^\/wardrobe\/(\d+)\?/.exec(String(res.headers.location))![1],
    );
  };

  /** Holds `first` open while `second` waits on it (interleave.ts). */
  const interleave = <A, B>(
    first: (tx: Queryable) => Promise<A>,
    second: () => Promise<B>,
  ) => interleaveOn(t.db, first, second);

  /** A saved outfit of the owner's, of these garments. */
  const outfitOf = async (garmentIds: number[]) => {
    const saved = await pickIdea(t.db, t.owner.id, { garmentIds });
    if (saved === 'not-found') throw new Error('garments not found');
    return saved.id;
  };

  /** The owner's entries on `day`, by id. */
  const entriesOn = (day: IsoDate) =>
    t.db
      .select({
        id: outfitCalendar.id,
        outfitId: outfitCalendar.outfitId,
        occasion: outfitCalendar.occasion,
        plannedBy: outfitCalendar.plannedBy,
      })
      .from(outfitCalendar)
      .where(
        and(
          eq(outfitCalendar.ownerId, t.owner.id),
          eq(outfitCalendar.day, day),
        ),
      )
      .orderBy(asc(outfitCalendar.id));

  /** An entry "Plan my week" made: planned 'auto', recorded in a batch. */
  const autoEntry = (garmentIds: number[], day: IsoDate, occasion: Occasion) =>
    t.db.transaction(async (tx) => {
      const weekPlanId = await createWeekPlan(tx, t.owner.id);
      const picked = await pickIdea(tx, t.owner.id, {
        garmentIds,
        plan: { day, occasion, plannedBy: 'auto' },
      });
      if (picked === 'not-found') throw new Error('garments not found');
      const [entry] = await tx
        .select({ id: outfitCalendar.id })
        .from(outfitCalendar)
        .where(
          and(
            eq(outfitCalendar.outfitId, picked.id),
            eq(outfitCalendar.day, day),
          ),
        );
      await recordAutoEntry(tx, {
        entryId: entry.id,
        weekPlanId,
        outfitCreated: !picked.alreadySaved,
        needs: null,
      });
      return { entryId: entry.id, outfitId: picked.id };
    });

  beforeAll(async () => {
    t = await createTestApp();
    tops = [
      await garmentIn('White tee', 'tops', 'white'),
      await garmentIn('Grey tee', 'tops', 'grey'),
      await garmentIn('Black tee', 'tops', 'black'),
    ];
    bottoms = [
      await garmentIn('Blue jeans', 'bottoms', 'blue'),
      await garmentIn('Black chinos', 'bottoms', 'black'),
      await garmentIn('Beige chinos', 'bottoms', 'beige'),
    ];
    shoes = [
      await garmentIn('White sneakers', 'footwear', 'white'),
      await garmentIn('Brown boots', 'footwear', 'brown'),
    ];
  });

  afterAll(() => t?.cleanup());

  // Every test starts without outfits, entries or batches, the closet whole
  // (a plain delete is fine: nothing here is worn history).
  beforeEach(async () => {
    await t.db.delete(outfit);
    await t.db.delete(weekPlan);
    await t.db.delete(weekReplan);
    await t.db
      .update(garment)
      .set({ status: 'closet' })
      .where(eq(garment.ownerId, t.owner.id));
  });

  describe('scheduling against a replace (the unique key)', () => {
    it('a replace that waited on a schedule of its outfit is refused with a 409, not a 500', async () => {
      const day = addDays(t.today(), 2);
      const planned = await outfitOf([tops[0], bottoms[0], shoes[0]]);
      const chosen = await outfitOf([tops[1], bottoms[1], shoes[1]]);
      const { id: entryId } = await scheduled(planned, day, 'work');

      const [schedule, replace] = await interleave(
        (tx) =>
          scheduleOutfit(tx, {
            ownerId: t.owner.id,
            outfitId: chosen,
            day,
            occasion: 'evening',
          }),
        () =>
          replaceEntryOutfit(
            t.db,
            t.owner.id,
            { entryId, day, occasion: 'work' },
            { outfitId: chosen },
          ),
      );
      expect(schedule).toMatchObject({ outcome: 'scheduled' });
      expect(replace).toEqual({
        outcome: 'already-on-day',
        outfitId: chosen,
        occasion: 'evening',
      });
      expect(
        (await entriesOn(day)).map((e) => [e.outfitId, e.occasion]),
      ).toEqual([
        [planned, 'work'],
        [chosen, 'evening'],
      ]);
    });

    it('a schedule that waited on a replace to its outfit finds it on the day', async () => {
      const day = addDays(t.today(), 3);
      const planned = await outfitOf([tops[0], bottoms[0], shoes[0]]);
      const chosen = await outfitOf([tops[1], bottoms[1], shoes[1]]);
      const { id: entryId } = await scheduled(planned, day, 'work');

      const [replace, schedule] = await interleave(
        (tx) =>
          replaceEntryOutfit(
            tx,
            t.owner.id,
            { entryId, day, occasion: 'work' },
            { outfitId: chosen },
          ),
        () =>
          scheduleOutfit(t.db, {
            ownerId: t.owner.id,
            outfitId: chosen,
            day,
            occasion: 'evening',
          }),
      );
      expect(replace).toMatchObject({ outcome: 'replaced', outfitId: chosen });
      // The occasion the outfit kept, read under the lock after the replace.
      expect(schedule).toEqual({
        outcome: 'already-scheduled',
        adopted: false,
        occasion: 'work',
      });
      expect(await entriesOn(day)).toEqual([
        { id: entryId, outfitId: chosen, occasion: 'work', plannedBy: 'user' },
      ]);
    });

    /** `outfitId` planned by the person; the new entry's id. */
    async function scheduled(
      outfitId: number,
      day: IsoDate,
      occasion: Occasion,
    ) {
      const result = await scheduleOutfit(t.db, {
        ownerId: t.owner.id,
        outfitId,
        day,
        occasion,
      });
      if (result === 'no-such-outfit' || result.outcome !== 'scheduled') {
        throw new Error(`outfit ${outfitId} not scheduled`);
      }
      return result;
    }
  });

  describe('a replace with the outfit the entry already has', () => {
    it("takes the week planner's entry over, and says so", async () => {
      const day = addDays(t.today(), 1);
      const { entryId, outfitId } = await autoEntry(
        [tops[0], bottoms[0], shoes[0]],
        day,
        'all-day',
      );
      const target = { entryId, day, occasion: 'all-day' as const };
      const outcome = await replaceEntryOutfit(t.db, t.owner.id, target, {
        outfitId,
      });
      expect(outcome).toMatchObject({
        outcome: 'unchanged',
        outfitId,
        adopted: true,
      });
      expect(await entriesOn(day)).toEqual([
        { id: entryId, outfitId, occasion: 'all-day', plannedBy: 'user' },
      ]);
      expect(replaceMessage(t.owner.id, target, outcome)).toBe(
        `Calendar entry ${entryId} (${day} all-day) already holds outfit ${outfitId}; taken over from the week planner by user ${t.owner.id}`,
      );

      // The person's own entry: nothing to take over.
      const again = await replaceEntryOutfit(t.db, t.owner.id, target, {
        outfitId,
      });
      expect(again).toMatchObject({ outcome: 'unchanged', adopted: false });
    });

    it('through the pick of its garments too (Today’s Change on the same idea)', async () => {
      const day = addDays(t.today(), 1);
      const garmentIds = [tops[1], bottoms[1], shoes[1]];
      const { entryId, outfitId } = await autoEntry(garmentIds, day, 'work');
      const outcome = await replaceEntryOutfit(
        t.db,
        t.owner.id,
        { entryId, day, occasion: 'work' },
        { garmentIds },
      );
      expect(outcome).toMatchObject({
        outcome: 'unchanged',
        outfitId,
        alreadySaved: true,
        adopted: true,
      });
      expect((await entriesOn(day))[0].plannedBy).toBe('user');
    });
  });

  describe('the daily re-plan against a live write', () => {
    let deps: ReplanDeps;

    beforeAll(() => {
      deps = {
        db: t.db,
        weather: undefined,
        push: undefined,
        timeZone: t.timeZone,
        logger: t.logger.child({ context: 'WeekPlan' }),
      };
    });

    /**
     * Tomorrow's auto entry, whose top is then archived: the re-plan's
     * verdict is a swap (the control case proves it).
     */
    const unwearableAutoEntry = async () => {
      const day = addDays(t.today(), 1);
      const planned = await autoEntry(
        [tops[0], bottoms[0], shoes[0]],
        day,
        'all-day',
      );
      const archived = await setGarmentStatus(t.db, tops[0], t.owner.id, {
        event: 'archive',
      });
      expect(archived.ok).toBe(true);
      return { day, ...planned };
    };

    it('swaps an unwearable auto entry when nobody writes meanwhile (the control)', async () => {
      const { day, outfitId } = await unwearableAutoEntry();
      const outcome = await replanToday(deps, t.owner.id, new Date());
      expect(outcome).toMatchObject({ kind: 'replanned' });
      const entries = await entriesOn(day);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ plannedBy: 'auto' });
      expect(entries[0].outfitId).not.toBe(outfitId);
    });

    it('leaves the entry the person took over by planning its outfit again', async () => {
      const { day, entryId, outfitId } = await unwearableAutoEntry();
      const [schedule, replan] = await interleave(
        (tx) =>
          scheduleOutfit(tx, {
            ownerId: t.owner.id,
            outfitId,
            day,
            occasion: 'all-day',
          }),
        () => replanToday(deps, t.owner.id, new Date()),
      );
      expect(schedule).toEqual({
        outcome: 'already-scheduled',
        adopted: true,
        occasion: 'all-day',
      });
      expect(replan).toEqual({ kind: 'skipped' });
      // One outfit in the slot, the person's: no swap beside it.
      expect(await entriesOn(day)).toEqual([
        { id: entryId, outfitId, occasion: 'all-day', plannedBy: 'user' },
      ]);
    });

    it('swaps in nothing for the entry the person deleted', async () => {
      const { day, entryId } = await unwearableAutoEntry();
      const outfits = await t.db.$count(outfit);
      const [deleted, replan] = await interleave(
        (tx) => deleteEntry(tx, entryId, t.owner.id),
        () => replanToday(deps, t.owner.id, new Date()),
      );
      expect(deleted).toEqual({ selfies: [] });
      expect(replan).toEqual({ kind: 'skipped' });
      expect(await entriesOn(day)).toEqual([]);
      expect(await t.db.$count(outfit)).toBe(outfits);
    });

    it('defers, the day unclaimed, behind a write that holds the lock past its timeout (#134)', async () => {
      const { day, outfitId } = await unwearableAutoEntry();
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let held!: () => void;
      const holding = new Promise<void>((resolve) => (held = resolve));
      const holder = t.db.transaction(async (tx) => {
        await lockOwner(tx, t.owner.id);
        held();
        await released;
      });
      await Promise.race([holding, holder]);
      const replan = await replanToday(deps, t.owner.id, new Date());
      release();
      await holder;

      expect(replan).toEqual({ kind: 'deferred' });
      expect(await t.db.$count(weekReplan)).toBe(0);
      expect(
        t.logs
          .messages('warn', 'WeekPlan')
          .some((line) =>
            line.startsWith(
              `Week re-plan for user ${t.owner.id} on ${t.today()} deferred: replanUser for owner ${t.owner.id} waited`,
            ),
          ),
      ).toBe(true);
      // The next minute's run judges it.
      expect(await replanToday(deps, t.owner.id, new Date())).toMatchObject({
        kind: 'replanned',
      });
      expect((await entriesOn(day))[0].outfitId).not.toBe(outfitId);
    });
  });

  describe('the lock timeout (#134, #158)', () => {
    // lockOwner sets lock_timeout in the lock's own statement: it bounds the
    // wait only while set_config is computed in the scan below LockRows.
    it('is set below LockRows, in the same statement as the lock', async () => {
      const query = lockOwnerQuery(t.db, t.owner.id).toSQL();
      const { rows } = await t.db.$client.query<{
        'QUERY PLAN': [{ Plan: PlanNode }];
      }>(`explain (verbose, format json) ${query.sql}`, query.params);
      const [{ Plan: top }] = rows[0]['QUERY PLAN'];
      expect(top['Node Type']).toBe('LockRows');
      const scan = top.Plans![0];
      expect(scan.Output!.join(' ')).toContain('set_config');
    });

    it("names the joined writer that waited, not its caller's", async () => {
      // Another transaction holds a garment of the idea: pickIdea's FOR
      // SHARE, inside wearIdea's owner transaction, waits past the bound.
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let held!: () => void;
      const holding = new Promise<void>((resolve) => (held = resolve));
      const holder = t.db.transaction(async (tx) => {
        await tx
          .select({ id: garment.id })
          .from(garment)
          .where(eq(garment.id, tops[0]))
          .for('update');
        held();
        await released;
      });
      await Promise.race([holding, holder]);
      t.logs.clear();
      const res = await t.inject({
        method: 'POST',
        url: '/today/wear',
        ...formPayload({
          garmentId: [tops[0], bottoms[0]].map(String),
          occasion: 'all-day',
        }),
      });
      release();
      await holder;
      expect(res.statusCode).toBe(503);
      expect(t.logs.messages('warn', 'Web')).toContainEqual(
        expect.stringContaining(
          `(pickIdea for owner ${t.owner.id} waited 5000 ms for a lock)`,
        ),
      );
    });
  });

  describe('a pick against an archive or a delete of its garment', () => {
    const idea = () => [tops[2], bottoms[2], shoes[1]];

    it('a pick that waited on an archive refuses the garment and writes nothing', async () => {
      const day = addDays(t.today(), 1);
      const [archived, pick] = await interleave(
        (tx) => setGarmentStatus(tx, tops[2], t.owner.id, { event: 'archive' }),
        () =>
          pickIdea(t.db, t.owner.id, {
            garmentIds: idea(),
            plan: { day, occasion: 'all-day' },
          }),
      );
      expect(archived).toMatchObject({ ok: true, to: 'archived' });
      expect(pick).toBe('not-found');
      expect(await t.db.$count(outfit)).toBe(0);
      expect(await entriesOn(day)).toEqual([]);
    });

    it('a pick that waited on a delete refuses the garment and writes nothing', async () => {
      const day = addDays(t.today(), 1);
      const doomed = await garmentIn('Olive tee', 'tops', 'green');
      const [deleted, pick] = await interleave(
        (tx) => deleteGarment(tx, doomed, t.owner.id),
        () =>
          pickIdea(t.db, t.owner.id, {
            garmentIds: [doomed, bottoms[2], shoes[1]],
            plan: { day, occasion: 'all-day' },
          }),
      );
      // Deleted (it had no photo).
      expect(deleted).toEqual({ status: 'closet', photo: null });
      expect(pick).toBe('not-found');
      expect(await t.db.$count(outfit)).toBe(0);
      expect(await entriesOn(day)).toEqual([]);
    });

    it('an archive that waited on a pick comes after its outfit, whole', async () => {
      const day = addDays(t.today(), 1);
      const [pick, archived] = await interleave(
        (tx) =>
          pickIdea(tx, t.owner.id, {
            garmentIds: idea(),
            plan: { day, occasion: 'all-day' },
          }),
        () => setGarmentStatus(t.db, tops[2], t.owner.id, { event: 'archive' }),
      );
      expect(archived).toMatchObject({ ok: true, to: 'archived' });
      if (pick === 'not-found') throw new Error('the pick was refused');
      const slots = await t.db
        .select({ garmentId: outfitSlot.garmentId })
        .from(outfitSlot)
        .where(eq(outfitSlot.outfitId, pick.id));
      expect(slots.map((s) => s.garmentId).sort((a, b) => a! - b!)).toEqual(
        idea().sort((a, b) => a - b),
      );
      expect(await entriesOn(day)).toHaveLength(1);
    });
  });
});
