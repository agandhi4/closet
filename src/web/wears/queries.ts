import { and, desc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import type { Db, Queryable } from '../../db/client';
import {
  file,
  garment,
  garmentWear,
  outfitCalendar,
  outfitSlot,
} from '../../db/schema';
import {
  type AwayReason,
  defaultWashAfterByCategory,
  NEVER_WASH,
} from '../../wardrobe/availability';
import type { IsoDate } from '../calendar/calendar-date';
import type { ImageRef } from '../files/image-url';
import { inCloset, ownedGarment } from '../wardrobe/status';

/**
 * Wears, washes and away: the owner's own records about their garments
 * (docs/plans/2026-09-26-wardrobe-features.md, section 1). The one writer of
 * each: `garment_wear` rows (setEntryWorn, setWoreToday), last_washed_on
 * (markWashed), away (setAway). Private like outfits and the calendar:
 * every function is scoped to the owner, and the routes never reach them
 * through a share (src/web/wears/routes.tsx).
 *
 * The wash rules as query conditions live here too, built from
 * src/wardrobe/availability.ts's constants so the two cannot drift
 * (test/integration/wears.spec.ts compares them on the same garments).
 * Every expression below is correlated with an unaliased `garment` in the
 * outer query.
 */

// A built-in category's default limit, from the pure table. The values are
// the code's own constants (category names and small integers), inlined
// because a CASE's parameters would be typed text.
const defaultLimit = sql`case ${garment.category} ${sql.raw(
  defaultWashAfterByCategory()
    .map(([category, limit]) => `when '${category}' then ${limit}`)
    .join(' '),
)} end`;

/** washLimit() in SQL: the garment's setting, else its role's; null for never. */
const washLimit = sql<
  number | null
>`(case when ${garment.washAfterWears} = ${sql.raw(
  String(NEVER_WASH),
)} then null else coalesce(${garment.washAfterWears}, ${defaultLimit}) end)`;

/** wearsSinceWash() in SQL: distinct days after last_washed_on. */
export function wearsSinceWashSql(): SQL<number> {
  return sql<number>`(select count(distinct ${garmentWear.day})::int from ${garmentWear} where ${garmentWear.garmentId} = ${garment.id} and (${garment.lastWashedOn} is null or ${garmentWear.day} > ${garment.lastWashedOn}))`;
}

/**
 * dirtyCopies() in SQL: floor(wears / limit) (integer division) capped at
 * the quantity; 0 without a limit. The CASE is not a coalesce around
 * least(): Postgres' least() ignores a NULL argument, so a garment that
 * never needs a wash would come out all dirty.
 */
export function dirtyCopiesSql(): SQL<number> {
  return sql<number>`(case when ${washLimit} is null then 0 else least(${garment.quantity}, ${wearsSinceWashSql()} / ${washLimit}) end)::int`;
}

/** needsWash() as a condition: at least one copy needs a wash. */
export function needsWash(): SQL {
  return sql`${dirtyCopiesSql()} > 0`;
}

/**
 * The generator-facing "available" rule as a query condition (isAvailable in
 * src/wardrobe/availability.ts): in the closet (inCloset: not a wishlist
 * item, not archived), not away, with a clean copy left. For the outfit gallery (#9) and the packing list
 * (#10): add it to the pool's where clause. Condition never counts.
 */
export function availableGarment(): SQL {
  return and(
    inCloset(),
    isNull(garment.away),
    sql`${dirtyCopiesSql()} < ${garment.quantity}`,
  )!;
}

/** The garment page's wear line: "Worn 12 times · 2 since washed · last worn yesterday". */
export interface WearSummary {
  /** Days worn, ever. */
  worn: number;
  sinceWash: number;
  lastWorn: IsoDate | null;
  /** Worn today by "Wore today" (undoable), through a worn calendar entry, or not. */
  today: 'single' | 'entry' | null;
}

/**
 * The garment's wear counts. The caller has found the garment in the
 * owner's wardrobe, so its row (grouped with none or more wears) is there.
 */
export async function wearSummary(
  db: Db,
  garmentId: number,
  today: IsoDate,
): Promise<WearSummary> {
  const [row] = await db
    .select({
      worn: sql<number>`count(distinct ${garmentWear.day})::int`,
      sinceWash: sql<number>`(count(distinct ${garmentWear.day}) filter (where ${garment.lastWashedOn} is null or ${garmentWear.day} > ${garment.lastWashedOn}))::int`,
      lastWorn: sql<IsoDate | null>`max(${garmentWear.day})::text`,
      single: sql<boolean>`coalesce(bool_or(${garmentWear.day} = ${today} and ${garmentWear.outfitCalendarId} is null), false)`,
      entry: sql<boolean>`coalesce(bool_or(${garmentWear.day} = ${today} and ${garmentWear.outfitCalendarId} is not null), false)`,
    })
    .from(garment)
    .leftJoin(garmentWear, eq(garmentWear.garmentId, garment.id))
    .where(eq(garment.id, garmentId))
    .groupBy(garment.id);
  const { single, entry, ...counts } = row;
  return { ...counts, today: single ? 'single' : entry ? 'entry' : null };
}

/** A garment on the laundry page. */
export interface LaundryItem {
  id: number;
  name: string | null;
  category: string;
  photo: ImageRef | null;
  quantity: number;
  /** Copies that need a wash; 0 for one worn but not due yet. */
  dirty: number;
}

/**
 * The owner's garments worn since their last wash that can get dirty (a
 * limit), in the closet (inCloset) and not away: those needing a wash
 * first, most copies first, then those worn but not due yet, newest first.
 */
export async function laundryList(
  db: Db,
  ownerId: number,
): Promise<LaundryItem[]> {
  return db
    .select({
      id: garment.id,
      name: garment.name,
      category: garment.category,
      photo: { fileName: file.fileName, version: file.version },
      quantity: garment.quantity,
      dirty: dirtyCopiesSql(),
    })
    .from(garment)
    .leftJoin(file, eq(file.id, garment.photoId))
    .where(
      and(
        eq(garment.ownerId, ownerId),
        inCloset(),
        isNull(garment.away),
        sql`${washLimit} is not null`,
        sql`${wearsSinceWashSql()} > 0`,
      ),
    )
    .orderBy(desc(dirtyCopiesSql()), desc(garment.id));
}

/** How many of the owner's garments in the closet need a wash (the wardrobe's prompt). */
export function countNeedingWash(db: Db, ownerId: number): Promise<number> {
  return db.$count(
    garment,
    and(
      eq(garment.ownerId, ownerId),
      inCloset(),
      isNull(garment.away),
      needsWash(),
    ),
  );
}

export type EntryWornOutcome =
  | { worn: boolean; changed: boolean; wears: number }
  | 'not-found'
  | 'future';

/**
 * Marks the owner's calendar entry worn or not, and its wears with it, in
 * one transaction (the entry locked, so two taps take turns): marking
 * snapshots the outfit's garments as they are now into `garment_wear`, one
 * row per garment on the entry's day, so editing the outfit later never
 * changes this history; unmarking deletes exactly the entry's rows
 * (deleting the entry does the same, by its foreign key). `worn` undefined
 * toggles (the pill posted by a page cached before it said which).
 * Idempotent: an entry already so is left alone. A day after `today` is
 * never marked worn ('future'). `at` is when it was worn (the tap; the seed's
 * evening). Used by POST /calendar/:id/worn and the seed.
 */
export function setEntryWorn(
  db: Queryable,
  input: {
    entryId: number;
    ownerId: number;
    worn: boolean | undefined;
    at: Date;
    today: IsoDate;
  },
): Promise<EntryWornOutcome> {
  return db.transaction(async (tx) => {
    const [entry] = await tx
      .select({
        id: outfitCalendar.id,
        day: outfitCalendar.day,
        outfitId: outfitCalendar.outfitId,
        wornAt: outfitCalendar.wornAt,
      })
      .from(outfitCalendar)
      .where(
        and(
          eq(outfitCalendar.id, input.entryId),
          eq(outfitCalendar.ownerId, input.ownerId),
        ),
      )
      .for('update');
    if (!entry) return 'not-found';
    const was = entry.wornAt !== null;
    const worn = input.worn ?? !was;
    if (worn === was) return { worn, changed: false, wears: 0 };
    if (!worn) {
      await tx
        .update(outfitCalendar)
        .set({ wornAt: null })
        .where(eq(outfitCalendar.id, entry.id));
      const deleted = await tx
        .delete(garmentWear)
        .where(eq(garmentWear.outfitCalendarId, entry.id))
        .returning({ id: garmentWear.id });
      return { worn, changed: true, wears: deleted.length };
    }
    if (entry.day > input.today) return 'future';
    await tx
      .update(outfitCalendar)
      .set({ wornAt: input.at })
      .where(eq(outfitCalendar.id, entry.id));
    // A slot only ever names a garment of the outfit's owner (the outfit
    // form's rule); the join keeps it so here too.
    const garments = await tx
      .selectDistinct({ id: garment.id })
      .from(outfitSlot)
      .innerJoin(garment, eq(garment.id, outfitSlot.garmentId))
      .where(
        and(
          eq(outfitSlot.outfitId, entry.outfitId),
          eq(garment.ownerId, input.ownerId),
        ),
      );
    if (garments.length > 0) {
      await tx
        .insert(garmentWear)
        .values(
          garments.map(({ id }) => ({
            garmentId: id,
            ownerId: input.ownerId,
            day: entry.day,
            outfitCalendarId: entry.id,
            createdAt: input.at,
          })),
        )
        .onConflictDoNothing();
    }
    return { worn, changed: true, wears: garments.length };
  });
}

/**
 * Keeps the wears of an outfit's calendar entries when the outfit is about
 * to be deleted (its entries cascade with it, and their wears would with
 * them): each becomes a day-level wear, the shape "Wore today" writes
 * (outfit_calendar_id null, the garment, owner, day and created_at kept).
 * Where the garment already has a day-level wear that day, that one stays
 * and the entry's row goes with the entry (distinct days count once
 * anyway). Run inside the deleting transaction, before the delete; the
 * entries are locked first, so a worn pill tapped meanwhile waits and then
 * finds its entry gone. Returns the wears kept.
 *
 * Used by deleteOutfit (src/web/outfits/queries.ts) only. Deleting one
 * calendar entry (deleteEntry) still removes its wears: that is the user
 * saying the entry was wrong, and the issue's rule. Deleting the outfit is
 * tidying the outfit list; the days it was worn stay history.
 */
export async function detachOutfitWears(
  tx: Queryable,
  outfitId: number,
  ownerId: number,
): Promise<number> {
  const entries = await tx
    .select({ id: outfitCalendar.id })
    .from(outfitCalendar)
    .where(
      and(
        eq(outfitCalendar.outfitId, outfitId),
        eq(outfitCalendar.ownerId, ownerId),
      ),
    )
    .for('update');
  if (entries.length === 0) return 0;
  const entryIds = entries.map((entry) => entry.id);
  // ON CONFLICT DO NOTHING: the partial unique index on (garment_id, day)
  // for day-level wears keeps an existing one. An outfit has one entry a
  // day at most, so the select itself holds no two rows for one key.
  const kept = await tx.execute(sql`
    insert into ${garmentWear} (garment_id, owner_id, day, outfit_calendar_id, created_at)
    select ${garmentWear.garmentId}, ${garmentWear.ownerId}, ${garmentWear.day}, null, ${garmentWear.createdAt}
    from ${garmentWear}
    where ${inArray(garmentWear.outfitCalendarId, entryIds)}
    on conflict do nothing`);
  await tx
    .delete(garmentWear)
    .where(inArray(garmentWear.outfitCalendarId, entryIds));
  return kept.rowCount ?? 0;
}

/**
 * "Wore today" on the garment page: one wear of the garment alone on `day`,
 * at most one a day (garment_wear_garment_id_day_single_unique), or its
 * undo, which removes only that row (a worn calendar entry's stay).
 * 'not-found' when the garment is not the owner's, 'wishlist' when it is a
 * wishlist item (not owned yet, so not worn).
 */
export async function setWoreToday(
  db: Db,
  input: { garmentId: number; ownerId: number; day: IsoDate; worn: boolean },
): Promise<'saved' | 'not-found' | 'wishlist'> {
  const [owned] = await db
    .select({ status: garment.status })
    .from(garment)
    .where(
      and(eq(garment.id, input.garmentId), eq(garment.ownerId, input.ownerId)),
    );
  if (!owned) return 'not-found';
  if (owned.status === 'wishlist') return 'wishlist';
  if (input.worn) {
    await db
      .insert(garmentWear)
      .values({
        garmentId: input.garmentId,
        ownerId: input.ownerId,
        day: input.day,
      })
      .onConflictDoNothing();
  } else {
    await db
      .delete(garmentWear)
      .where(
        and(
          eq(garmentWear.garmentId, input.garmentId),
          eq(garmentWear.day, input.day),
          isNull(garmentWear.outfitCalendarId),
        ),
      );
  }
  return 'saved';
}

/**
 * Washes the listed garments of the owner on `day` (every copy: laundry
 * day), the ids of others and of wishlist items ignored like unknown ones;
 * returns the ids washed. Wears on `day` itself count as before the wash. The garment
 * page's Washed, the laundry page's batch and the seed's Sundays.
 */
export async function markWashed(
  db: Queryable,
  ownerId: number,
  ids: number[],
  day: IsoDate,
): Promise<number[]> {
  if (ids.length === 0) return [];
  const washed = await db
    .update(garment)
    .set({ lastWashedOn: day })
    .where(
      and(
        eq(garment.ownerId, ownerId),
        inArray(garment.id, ids),
        ownedGarment(),
      ),
    )
    .returning({ id: garment.id });
  return washed.map((row) => row.id);
}

/**
 * Puts the owner's garment away (lent, at the repair shop) with a note, or
 * back in the closet (null, which clears the note). False when it is not
 * the owner's, or a wishlist item (nothing to lend yet).
 */
export async function setAway(
  db: Queryable,
  ownerId: number,
  garmentId: number,
  away: { reason: AwayReason; note: string | null } | null,
): Promise<boolean> {
  const updated = await db
    .update(garment)
    .set({ away: away?.reason ?? null, awayNote: away?.note ?? null })
    .where(
      and(
        eq(garment.id, garmentId),
        eq(garment.ownerId, ownerId),
        ownedGarment(),
      ),
    )
    .returning({ id: garment.id });
  return updated.length > 0;
}
