import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  type SQL,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import type { Db, Queryable } from '../../db/client';
import { file, garment, outfit, outfitSlot } from '../../db/schema';
import type { ImageRef } from '../files/image-url';
import type { IsoDate } from '../calendar/calendar-date';
import { insertEntry, type ScheduleOutcome } from '../calendar/queries';
import {
  type CategoryHead,
  clampIndex,
  type RowGarment,
  type SavedSlot,
} from './builder';

/**
 * Outfits' reads and writes. Outfits are private: every query is scoped to
 * the signed-in owner whatever wardrobe shares exist, and someone else's
 * outfit is a miss like a missing one (the routes answer 404 either way, so
 * ids reveal nothing; WardrobeAccess in src/web/sharing/access.ts). What an
 * outfit wears is its outfit_slot rows, in position order (src/db/schema.ts).
 */

/** A garment an outfit shows on the list and detail pages. */
export interface OutfitGarment {
  id: number;
  name: string | null;
  photo: ImageRef | null;
}

export interface OutfitSummary {
  id: number;
  name: string | null;
  notes: string | null;
  /** The chosen garments in the order the outfit was built. */
  garments: OutfitGarment[];
}

/** One builder row as the form posts it. */
export interface SlotInput {
  category: string;
  garmentId: number | null;
}

export interface OutfitInput {
  /** Absent on an update: left as it is. */
  name?: string | null;
  notes?: string | null;
  slots: SlotInput[];
  /** "Add to calendar": plan the outfit on this day in the same transaction. */
  scheduleDate?: IsoDate;
}

export interface SaveResult {
  id: number;
  slots: number;
  /** Posted garment ids that are not the owner's, stored as empty slots. */
  refused: number;
  schedule?: ScheduleOutcome;
}

/**
 * Outfits matching `where`, newest first, each with its chosen garments in
 * slot order (empty slots show nothing). One statement: db.query nests the
 * slots, garments and photos as JSON, and the result is plain rows.
 */
async function outfitsWithGarments(
  db: Db,
  where: SQL | undefined,
): Promise<(OutfitSummary & { shareableId: string })[]> {
  const rows = await db.query.outfit.findMany({
    columns: { id: true, name: true, notes: true, shareableId: true },
    where,
    orderBy: desc(outfit.id),
    with: {
      slots: {
        columns: {},
        where: isNotNull(outfitSlot.garmentId),
        orderBy: asc(outfitSlot.position),
        with: {
          garment: {
            columns: { id: true, name: true },
            with: { photo: { columns: { fileName: true, version: true } } },
          },
        },
      },
    },
  });
  return rows.map(({ slots, ...fields }) => ({
    ...fields,
    garments: slots.flatMap(({ garment: shown }) => (shown ? [shown] : [])),
  }));
}

/** The list page: every outfit of the owner's. */
export function listOutfits(db: Db, ownerId: number): Promise<OutfitSummary[]> {
  return outfitsWithGarments(db, eq(outfit.ownerId, ownerId));
}

/** The detail page's outfit, or undefined when it is not the owner's. */
export async function findOutfit(
  db: Db,
  id: number,
  ownerId: number,
): Promise<(OutfitSummary & { shareableId: string }) | undefined> {
  const [found] = await outfitsWithGarments(
    db,
    and(eq(outfit.id, id), eq(outfit.ownerId, ownerId)),
  );
  return found;
}

/** The edit form's fields, or undefined when the outfit is not the owner's. */
export async function findOutfitFields(
  db: Db,
  id: number,
  ownerId: number,
): Promise<
  { id: number; name: string | null; notes: string | null } | undefined
> {
  const [row] = await db
    .select({ id: outfit.id, name: outfit.name, notes: outfit.notes })
    .from(outfit)
    .where(and(eq(outfit.id, id), eq(outfit.ownerId, ownerId)));
  return row;
}

// The garment columns a builder row shows; `file` is left-joined.
const rowGarment = {
  id: garment.id,
  name: garment.name,
  brand: garment.brand,
  color: garment.color,
  size: garment.size,
  notes: garment.notes,
  archived: garment.archived,
};
const rowPhoto = { fileName: file.fileName, version: file.version };

/** The garments prev/next cycle through: the owner's unarchived ones in `category`. */
function inCycle(ownerId: number, category: string) {
  return and(
    eq(garment.ownerId, ownerId),
    eq(garment.category, category),
    eq(garment.archived, false),
  );
}

/**
 * The new-outfit builder: for each category of the owner's unarchived
 * garments, how many there are and the newest one (the row's default). One
 * statement returning one row per category, never the whole wardrobe.
 */
export async function categoryHeads(
  db: Db,
  ownerId: number,
): Promise<CategoryHead[]> {
  const ranked = db
    .select({
      ...rowGarment,
      category: garment.category,
      photoId: garment.photoId,
      rank: sql<number>`(row_number() over (partition by ${garment.category} order by ${garment.id} desc))::int`.as(
        'rank',
      ),
      count:
        sql<number>`(count(*) over (partition by ${garment.category}))::int`.as(
          'count',
        ),
    })
    .from(garment)
    .where(and(eq(garment.ownerId, ownerId), eq(garment.archived, false)))
    .as('ranked');
  const rows = await db
    .select({
      id: ranked.id,
      name: ranked.name,
      brand: ranked.brand,
      color: ranked.color,
      size: ranked.size,
      notes: ranked.notes,
      archived: ranked.archived,
      category: ranked.category,
      count: ranked.count,
      photo: rowPhoto,
    })
    .from(ranked)
    .leftJoin(file, eq(file.id, ranked.photoId))
    .where(eq(ranked.rank, 1));
  return rows.map(({ category, count, ...shown }) => ({
    category,
    count,
    garment: shown,
  }));
}

/**
 * The row fragment's garment: the one at cycle position `index` (clamped;
 * 1 = newest) in `category`, with the category's count. Two small
 * statements (the count bounds the position), one garment row.
 */
export async function garmentAt(
  db: Db,
  ownerId: number,
  category: string,
  requested: number | undefined,
): Promise<{ count: number; index: number; garment: RowGarment | null }> {
  const [{ total }] = await db
    .select({ total: count() })
    .from(garment)
    .where(inCycle(ownerId, category));
  const index = clampIndex(requested, total);
  if (index === 0) return { count: total, index, garment: null };
  const [row] = await db
    .select({ ...rowGarment, photo: rowPhoto })
    .from(garment)
    .leftJoin(file, eq(file.id, garment.photoId))
    .where(inCycle(ownerId, category))
    .orderBy(desc(garment.id))
    .limit(1)
    .offset(index - 1);
  // A garment archived between the count and this read shortens the cycle.
  return row
    ? { count: total, index, garment: row }
    : { count: total, index: 0, garment: null };
}

/** The categories of the owner's unarchived garments (the "add row" suggestions). */
export async function wardrobeCategories(
  db: Db,
  ownerId: number,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ category: garment.category })
    .from(garment)
    .where(and(eq(garment.ownerId, ownerId), eq(garment.archived, false)));
  return rows.map((row) => row.category);
}

/**
 * The edit form: an outfit's slots in order, each with its garment (archived
 * or not), the size of its category's cycle and the garment's place in it.
 * One statement; the two counts are correlated subqueries per slot.
 */
export async function savedSlots(
  db: Db,
  outfitId: number,
  ownerId: number,
): Promise<SavedSlot[]> {
  const peer = alias(garment, 'peer');
  const peersInCycle = and(
    eq(peer.ownerId, ownerId),
    eq(peer.category, outfitSlot.category),
    eq(peer.archived, false),
  );
  const cycleSize = db
    .select({ n: sql<number>`count(*)::int` })
    .from(peer)
    .where(peersInCycle);
  const newerInCycle = db
    .select({ n: sql<number>`count(*)::int` })
    .from(peer)
    .where(and(peersInCycle, gt(peer.id, outfitSlot.garmentId)));
  const rows = await db
    .select({
      category: outfitSlot.category,
      count: sql<number>`(${cycleSize})`,
      newer: sql<number>`(${newerInCycle})`,
      garment: { ...rowGarment, category: garment.category },
      photo: rowPhoto,
    })
    .from(outfitSlot)
    .leftJoin(garment, eq(garment.id, outfitSlot.garmentId))
    .leftJoin(file, eq(file.id, garment.photoId))
    .where(eq(outfitSlot.outfitId, outfitId))
    .orderBy(asc(outfitSlot.position));
  return rows.map(({ garment: chosen, photo, ...slot }) => ({
    ...slot,
    garment: chosen ? { ...chosen, photo } : null,
  }));
}

/**
 * Writes `slots` as the outfit's positions 0..n-1 (the caller has removed
 * any old ones). A garment id that is not one of the owner's garments (a
 * hand-made request; the form only offers their own) is dropped and its row
 * kept empty, so a slot never names another user's garment. Archived
 * garments are still the owner's and stay. Returns how many ids it dropped.
 */
async function insertSlots(
  tx: Queryable,
  outfitId: number,
  ownerId: number,
  slots: SlotInput[],
): Promise<number> {
  if (slots.length === 0) return 0;
  const requested = [...new Set(slots.flatMap((slot) => slot.garmentId ?? []))];
  const owned = new Set(
    requested.length === 0
      ? []
      : (
          await tx
            .select({ id: garment.id })
            .from(garment)
            .where(
              and(eq(garment.ownerId, ownerId), inArray(garment.id, requested)),
            )
        ).map((row) => row.id),
  );
  let refused = 0;
  await tx.insert(outfitSlot).values(
    slots.map((slot, position) => {
      const keep = slot.garmentId !== null && owned.has(slot.garmentId);
      if (slot.garmentId !== null && !keep) refused += 1;
      return {
        outfitId,
        position,
        category: slot.category,
        garmentId: keep ? slot.garmentId : null,
      };
    }),
  );
  return refused;
}

/**
 * POST /outfits: the outfit, its slots and the optional calendar entry
 * commit together or not at all.
 */
export function createOutfit(
  db: Db,
  ownerId: number,
  input: OutfitInput,
): Promise<SaveResult> {
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(outfit)
      .values({
        // Share links address outfits by this (the /share page).
        shareableId: randomUUID(),
        ownerId,
        name: input.name ?? null,
        notes: input.notes ?? null,
      })
      .returning({ id: outfit.id });
    const refused = await insertSlots(tx, created.id, ownerId, input.slots);
    const schedule = input.scheduleDate
      ? await insertEntry(tx, {
          ownerId,
          outfitId: created.id,
          day: input.scheduleDate,
        })
      : undefined;
    return { id: created.id, slots: input.slots.length, refused, schedule };
  });
}

/**
 * POST /outfits/:id: fields, slots (replaced whole: the form posts every row)
 * and the optional calendar entry, in one transaction. 'not-found' for an
 * outfit that is not the owner's, before anything is written.
 */
export function updateOutfit(
  db: Db,
  id: number,
  ownerId: number,
  input: OutfitInput,
): Promise<SaveResult | 'not-found'> {
  return db.transaction(async (tx) => {
    // FOR UPDATE: two saves of one outfit take turns. Without the lock both
    // delete the old slots and the second insert collides with the first's
    // new rows on the (outfit_id, position) key.
    const [found] = await tx
      .select({ id: outfit.id })
      .from(outfit)
      .where(and(eq(outfit.id, id), eq(outfit.ownerId, ownerId)))
      .for('update');
    if (!found) return 'not-found';
    const fields = {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.notes !== undefined && { notes: input.notes }),
    };
    if (Object.keys(fields).length > 0) {
      await tx.update(outfit).set(fields).where(eq(outfit.id, id));
    }
    await tx.delete(outfitSlot).where(eq(outfitSlot.outfitId, id));
    const refused = await insertSlots(tx, id, ownerId, input.slots);
    const schedule = input.scheduleDate
      ? await insertEntry(tx, {
          ownerId,
          outfitId: id,
          day: input.scheduleDate,
        })
      : undefined;
    return { id, slots: input.slots.length, refused, schedule };
  });
}

/** Deletes the owner's outfit; its slots and calendar entries cascade. */
export async function deleteOutfit(
  db: Db,
  id: number,
  ownerId: number,
): Promise<boolean> {
  const deleted = await db
    .delete(outfit)
    .where(and(eq(outfit.id, id), eq(outfit.ownerId, ownerId)))
    .returning({ id: outfit.id });
  return deleted.length > 0;
}

/**
 * The public share page (/share?type=outfit, OpenGraphService, still Nest):
 * an outfit by its share id, whoever asks, with its owner's email and its
 * chosen garments in order. The photo's shareableId addresses the
 * watermarked Open Graph image.
 */
export async function findSharedOutfit(db: Db, shareableId: string) {
  const row = await db.query.outfit.findFirst({
    columns: { name: true, notes: true },
    where: eq(outfit.shareableId, shareableId),
    with: {
      owner: { columns: { email: true } },
      slots: {
        columns: {},
        where: isNotNull(outfitSlot.garmentId),
        orderBy: asc(outfitSlot.position),
        with: {
          garment: {
            columns: { name: true },
            with: {
              photo: {
                columns: { fileName: true, version: true, shareableId: true },
              },
            },
          },
        },
      },
    },
  });
  if (!row) return undefined;
  const { slots, ...fields } = row;
  return {
    ...fields,
    garments: slots.flatMap(({ garment: shown }) => (shown ? [shown] : [])),
  };
}
