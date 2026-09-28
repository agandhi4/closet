import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Db, Queryable } from '../../db/client';
import {
  file,
  garment,
  outfit,
  outfitCalendar,
  outfitSlot,
  selfie,
} from '../../db/schema';
import type { Occasion } from '../../wardrobe/occasions';
import type { PlannedBy } from '../../wardrobe/week';
import { ownerTransaction } from '../auth/queries';
import type { ImageRef } from '../files/image-url';
import type { IsoDate } from '../calendar/calendar-date';
import { insertEntry, type ScheduleOutcome } from '../calendar/queries';
import type { SelfieRef } from '../selfies/queries';
import { ownedGarment } from '../wardrobe/status';
import { prunePacked, tripsOfOutfit } from '../trips/packed';
import { detachOutfitWears } from '../wears/queries';

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
  /** Where it goes in an OutfitCollage (its role). */
  category: string;
  photo: ImageRef | null;
}

export interface OutfitSummary {
  id: number;
  name: string | null;
  notes: string | null;
  /** The chosen garments in the order the outfit was built. */
  garments: OutfitGarment[];
}

// Caps on what a person types, shared by the inputs' maxlength and the
// routes' schemas (a longer post is a 400): Styling's Save sheet, the
// outfit form old cached pages still post, and pickIdea's generated names.
// The columns are text since drizzle/0005; the name stays at the 255 it has
// always been, so no saved outfit fails its own edit.
export const OUTFIT_NAME_MAX = 255;
export const OUTFIT_NOTES_MAX = 4000;

/** One slot as a write takes it: a category and its garment (or none). */
export interface SlotInput {
  category: string;
  garmentId: number | null;
}

export interface OutfitInput {
  /** Absent on an update: left as it is. */
  name?: string | null;
  notes?: string | null;
  slots: SlotInput[];
  /** "Add to calendar": plan the outfit on this day, for this occasion, in the same transaction. */
  plan?: { day: IsoDate; occasion: Occasion; plannedBy?: PlannedBy };
}

export interface SaveResult {
  id: number;
  slots: number;
  /** Posted garment ids that are not the owner's, stored as empty slots. */
  refused: number;
  schedule?: ScheduleOutcome;
  /** An update: the week planner's entries of the outfit that became the person's. */
  entriesClaimed?: number;
}

/**
 * Outfits matching `where`, newest first, each with its chosen garments in
 * slot order (empty slots show nothing). One statement: db.query nests the
 * slots, garments and photos as JSON, and the result is plain rows.
 */
async function outfitsWithGarments(
  db: Db,
  where: SQL | undefined,
  limit?: number,
): Promise<(OutfitSummary & { shareableId: string })[]> {
  const rows = await db.query.outfit.findMany({
    columns: { id: true, name: true, notes: true, shareableId: true },
    where,
    orderBy: desc(outfit.id),
    limit,
    with: {
      slots: {
        columns: {},
        where: isNotNull(outfitSlot.garmentId),
        orderBy: asc(outfitSlot.position),
        with: {
          garment: {
            columns: { id: true, name: true, category: true },
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

/** The garment page's "In N outfits" (#84): how many, and the newest few. */
export interface GarmentOutfits {
  count: number;
  outfits: OutfitSummary[];
}

/**
 * The owner's outfits that hold `garmentId` (any slot), counted, and the
 * newest `limit` of them with their garments. Two statements, run together:
 * the count, and one db.query for the shown outfits.
 */
export async function outfitsWithGarment(
  db: Db,
  ownerId: number,
  garmentId: number,
  limit: number,
): Promise<GarmentOutfits> {
  const where = and(
    eq(outfit.ownerId, ownerId),
    inArray(
      outfit.id,
      db
        .select({ id: outfitSlot.outfitId })
        .from(outfitSlot)
        .where(eq(outfitSlot.garmentId, garmentId)),
    ),
  );
  const [count, outfits] = await Promise.all([
    db.$count(outfit, where),
    outfitsWithGarments(db, where, limit),
  ]);
  return { count, outfits };
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

/** A day the outfit was worn, with its selfie (#19): the Worn strip's. */
export interface WornDay {
  entryId: number;
  day: IsoDate;
  selfie: SelfieRef | null;
}

/** A day the outfit is planned for and not worn yet: the outfit page's "Planned". */
export interface PlannedDay {
  entryId: number;
  day: IsoDate;
  occasion: Occasion;
}

/**
 * The outfit page's entries (redesign plan section 1: "an outfit is a
 * record, not an event"; the page reads its entries rather than holding a
 * state of its own). `worn`: the entries worn or with a selfie (one taken
 * and the entry unmarked later still shows), newest first, the Worn strip;
 * `planned`: the rest from `today` on, soonest first. Past entries never
 * worn are neither: the plan passed.
 */
export interface OutfitEntries {
  worn: WornDay[];
  planned: PlannedDay[];
}

/**
 * The owner's outfit's entries (OutfitEntries), in one statement served by
 * outfit_calendar_outfit_id_index and the selfie's unique entry key.
 */
export async function outfitEntries(
  db: Db,
  outfitId: number,
  ownerId: number,
  today: IsoDate,
): Promise<OutfitEntries> {
  const rows = await db
    .select({
      entryId: outfitCalendar.id,
      day: outfitCalendar.day,
      occasion: outfitCalendar.occasion,
      wornAt: outfitCalendar.wornAt,
      selfieId: selfie.id,
      fileName: file.fileName,
      version: file.version,
    })
    .from(outfitCalendar)
    .leftJoin(selfie, eq(selfie.outfitCalendarId, outfitCalendar.id))
    .leftJoin(file, eq(file.id, selfie.photoId))
    .where(
      and(
        eq(outfitCalendar.outfitId, outfitId),
        eq(outfitCalendar.ownerId, ownerId),
        or(
          isNotNull(outfitCalendar.wornAt),
          isNotNull(selfie.id),
          gte(outfitCalendar.day, today),
        ),
      ),
    )
    .orderBy(desc(outfitCalendar.day), desc(outfitCalendar.id));
  const entries: OutfitEntries = { worn: [], planned: [] };
  for (const row of rows) {
    const { entryId, day, selfieId, fileName, version } = row;
    if (row.wornAt === null && selfieId === null) {
      entries.planned.unshift({ entryId, day, occasion: row.occasion });
      continue;
    }
    entries.worn.push({
      entryId,
      day,
      selfie:
        selfieId !== null && fileName !== null && version !== null
          ? { id: selfieId, photo: { fileName, version } }
          : null,
    });
  }
  return entries;
}

/**
 * What the Saved grid says under an outfit (redesign plan, "Outfits"):
 * how often it was worn and the next day it is planned for.
 */
export interface OutfitActivity {
  wornCount: number;
  /** The soonest entry from `today` on not worn yet; null when none. */
  nextPlanned: IsoDate | null;
}

/**
 * Every outfit of the owner's that has a calendar entry, with its
 * OutfitActivity: one grouped statement over the owner's entries (served
 * by outfit_calendar_owner_id_day_outfit_id_unique). An outfit never
 * planned is absent. Depends on the day, never the hour, so the Saved tab
 * (a stale-while-revalidate tab root) stays byte-stable within a day.
 */
export async function outfitActivity(
  db: Db,
  ownerId: number,
  today: IsoDate,
): Promise<Map<number, OutfitActivity>> {
  const rows = await db
    .select({
      outfitId: outfitCalendar.outfitId,
      wornCount: sql<number>`(count(*) filter (where ${outfitCalendar.wornAt} is not null))::int`,
      nextPlanned: sql<IsoDate | null>`(min(${outfitCalendar.day}) filter (where ${outfitCalendar.wornAt} is null and ${outfitCalendar.day} >= ${today}))::text`,
    })
    .from(outfitCalendar)
    .where(eq(outfitCalendar.ownerId, ownerId))
    .groupBy(outfitCalendar.outfitId);
  return new Map(rows.map(({ outfitId, ...activity }) => [outfitId, activity]));
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

/**
 * Writes `slots` as the outfit's positions 0..n-1 (the caller has removed
 * any old ones). A garment id that is not one of the owner's garments (a
 * hand-made request; the form only offers their own) is dropped and its row
 * kept empty, so a slot never names another user's garment, nor a wishlist
 * item (not owned yet). Archived garments were owned and stay. Returns how
 * many ids it dropped.
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
              and(
                eq(garment.ownerId, ownerId),
                inArray(garment.id, requested),
                ownedGarment(),
              ),
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
 * commit together or not at all. Inside a caller's transaction (the seed
 * writes a whole persona in one) this is a savepoint. Under the owner lock
 * when it plans (every calendar write, src/web/calendar/CLAUDE.md).
 */
export function createOutfit(
  db: Queryable,
  ownerId: number,
  input: OutfitInput,
): Promise<SaveResult> {
  const save = async (tx: Queryable): Promise<SaveResult> => {
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
    const schedule = input.plan
      ? (
          await insertEntry(tx, {
            ownerId,
            outfitId: created.id,
            ...input.plan,
          })
        ).outcome
      : undefined;
    return { id: created.id, slots: input.slots.length, refused, schedule };
  };
  return input.plan
    ? ownerTransaction(db, ownerId, 'createOutfit', save)
    : db.transaction(save);
}

/**
 * POST /outfits/:id: fields, slots (replaced whole: the form posts every row)
 * and the optional calendar entry, in one transaction, with the packed marks
 * of garments the edit took off a trip's list (prunePacked, #10).
 * 'not-found' for an outfit that is not the owner's, before anything is
 * written. Editing an outfit is editing the calendar entries that hold it
 * (the calendar chip's edit link is this form), so the week planner's
 * entries of it become the person's (planned_by 'user', #16): its re-plan
 * never swaps an outfit someone changed. Under the owner lock, taken
 * before the outfit's: the re-plan deletes outfits under it, so the other
 * order could deadlock, and the take-over must not land mid re-plan.
 */
export function updateOutfit(
  db: Db,
  id: number,
  ownerId: number,
  input: OutfitInput,
): Promise<SaveResult | 'not-found'> {
  return ownerTransaction(db, ownerId, 'updateOutfit', async (tx) => {
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
    const claimed = await tx
      .update(outfitCalendar)
      .set({ plannedBy: 'user' })
      .where(
        and(
          eq(outfitCalendar.outfitId, id),
          eq(outfitCalendar.plannedBy, 'auto'),
        ),
      )
      .returning({ id: outfitCalendar.id });
    // A garment the edit took out may have left a trip's packing list (#10).
    await prunePacked(tx, await tripsOfOutfit(tx, id));
    const schedule = input.plan
      ? (await insertEntry(tx, { ownerId, outfitId: id, ...input.plan }))
          .outcome
      : undefined;
    return {
      id,
      slots: input.slots.length,
      refused,
      schedule,
      entriesClaimed: claimed.length,
    };
  });
}

/**
 * Deletes the owner's outfit; its slots and calendar entries cascade, but
 * the days it was worn stay: detachOutfitWears (src/web/wears/queries.ts)
 * turns its entries' wears into day-level wears first, in the same
 * transaction. Never replace this with a plain delete: the cascade through
 * outfit_calendar would erase the garments' wear history (CLAUDE.md, Wears
 * and washes). The entries' selfies stay too, by their foreign key
 * (selfie.outfit_calendar_id, ON DELETE SET NULL): each becomes a look kept
 * on its day, with its photo, which the calendar still shows (#19). Its
 * trips lose it by trip_outfit's cascade, and their packed marks for the
 * garments no other trip outfit holds go too (prunePacked, #10).
 * Undefined when the outfit is not the owner's; else the wears kept.
 * Under the owner lock, before the outfit's (its entries go with it; the
 * re-plan and Undo call it holding the lock already).
 */
export function deleteOutfit(
  db: Queryable,
  id: number,
  ownerId: number,
): Promise<{ wearsKept: number } | undefined> {
  return ownerTransaction(db, ownerId, 'deleteOutfit', async (tx) => {
    // Locked like updateOutfit's: a save of this outfit takes its turn.
    const [found] = await tx
      .select({ id: outfit.id })
      .from(outfit)
      .where(and(eq(outfit.id, id), eq(outfit.ownerId, ownerId)))
      .for('update');
    if (!found) return undefined;
    const wearsKept = await detachOutfitWears(tx, id, ownerId);
    // Its trips lose it (trip_outfit cascades) and maybe garments with it.
    const trips = await tripsOfOutfit(tx, id);
    await tx.delete(outfit).where(eq(outfit.id, id));
    await prunePacked(tx, trips);
    return { wearsKept };
  });
}
