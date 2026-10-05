import {
  and,
  desc,
  eq,
  inArray,
  lt,
  notInArray,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { Db } from '../../db/client';
import { selectScalars } from '../../db/select-scalars';
import { file, garment, outfit, outfitSlot } from '../../db/schema';
import { photoRefJson, readPhotoRef } from '../files/queries';
import {
  builtInCategoriesOf,
  categoryRole,
  GARMENT_ROLES,
  type GarmentRole,
} from '../../wardrobe/properties';
import type { GarmentStatus } from '../../wardrobe/status';
import { inCapsule } from '../capsules/queries';
import { offeredIntoSql, slotMayNameSql } from '../outfits/gone-garments';
import { inCloset, offeredToStyle } from '../wardrobe/status';
import {
  type RoleWindow,
  type RowGarment,
  type RowState,
  STRIP_PAGE,
} from './rows';

/**
 * Styling's reads (#42). Every function reads one wardrobe, `ownerId`: the
 * requester's own, or a wardrobe shared with them that the route
 * authorized (authorizeWardrobe, view). What an outfit holds is only ever
 * read for its owner (savedOutfitSql); writes go through the outfit writers
 * (src/web/outfits/queries.ts, src/web/gallery/pick.ts).
 *
 * Most are scalar subqueries (#163): production pays a round trip per
 * statement (#156), so a request reads them together through selectScalars
 * (reads.ts), each owned here and read back by its reader.
 */

/** The garments a role's rows cycle through (none: `other` and every custom category). */
function inRole(role: GarmentRole): SQL {
  if (role !== 'none')
    return inArray(garment.category, builtInCategoriesOf(role));
  const others = GARMENT_ROLES.filter((r) => r !== 'none').flatMap(
    builtInCategoriesOf,
  );
  return notInArray(garment.category, others);
}

/** categoryRole in SQL: the role a row's garment plays, for the window per role. */
const roleOf: SQL<GarmentRole> = sql`case ${sql.join(
  GARMENT_ROLES.filter((role) => role !== 'none').flatMap((role) =>
    builtInCategoriesOf(role).map(
      (category) => sql`when ${garment.category} = ${category} then ${role}`,
    ),
  ),
  sql` `,
)} else 'none' end`;

function cycleOf(ownerId: number, capsuleId: number | undefined): SQL {
  return and(
    eq(garment.ownerId, ownerId),
    inCloset(),
    capsuleId === undefined ? undefined : inCapsule(capsuleId),
  )!;
}

/**
 * A RowGarment as JSON, an array in readRowGarment's order (no key per
 * garment), from `garment` left joined to its `file`.
 */
type RowGarmentJson = [
  id: number,
  name: string | null,
  category: string,
  status: GarmentStatus,
  fileName: string | null,
  version: number | null,
  variantKey: string | null,
];

const rowGarmentJson = sql`json_build_array(${garment.id}, ${garment.name}, ${garment.category}, ${garment.status}, ${file.fileName}, ${file.version}, ${file.variantKey})`;

function readRowGarment([
  id,
  name,
  category,
  status,
  fileName,
  version,
  variantKey,
]: RowGarmentJson): RowGarment {
  const photo =
    fileName === null || version === null
      ? null
      : readPhotoRef({ fileName, version, variantKey });
  return { id, name, category, status, photo };
}

/** A garment with the role its category plays. */
export type RoledGarment = RowGarment & { role: GarmentRole };

function roled(garment: RowGarment): RoledGarment {
  return { ...garment, role: categoryRole(garment.category) };
}

/** A garment a row holds, and that row's role: what the strips' windows must reach. */
export type Chosen = Pick<RowState, 'role'> & { garmentId: number };

/** A window's garment as roleWindowsSql's JSON has it: its role and count, then the garment. */
type WindowJson = [role: GarmentRole, count: number, ...RowGarmentJson];

/**
 * Every role the wardrobe (or the capsule) has closet garments of, each
 * with its count and the window a page shows: newest first, STRIP_PAGE
 * garments past the deepest chosen one in that role, so a chosen garment
 * deep in a long cycle is on its strip. Chosen is `chosen` (a garment in
 * a row of its own role: a posted row whose garment was recategorised
 * meanwhile, or is not the wardrobe's, reaches nothing, as its row falls
 * back to "No garment") and, with `outfitId`, every garment the
 * wardrobe's outfit holds (`?outfit=`, whose rows are its garments). One
 * scalar subquery whatever the wardrobe holds: the ranks and counts are
 * window functions, and only the windows' garments come back, in rank
 * order. Read back with readRoleWindows.
 */
export function roleWindowsSql(
  ownerId: number,
  options: {
    capsuleId?: number;
    chosen: readonly Chosen[];
    outfitId?: number;
  },
): SQL<WindowJson[]> {
  const { chosen, outfitId } = options;
  const ids = sql`array[${sql.join(
    chosen.map((c) => sql`${c.garmentId}`),
    sql`, `,
  )}]::int[]`;
  const roles = sql`array[${sql.join(
    chosen.map((c) => sql`${c.role}`),
    sql`, `,
  )}]::text[]`;
  const inRow = sql`exists (select from unnest(${ids}, ${roles}) as chosen (id, role) where chosen.id = ranked.id and chosen.role = ranked.role)`;
  const inOutfit =
    outfitId === undefined
      ? undefined
      : sql`ranked.id in (select ${outfitSlot.garmentId} from ${outfitSlot} inner join ${outfit} on ${eq(outfit.id, outfitSlot.outfitId)} where ${and(eq(outfit.id, outfitId), eq(outfit.ownerId, ownerId))})`;
  const isChosen = inOutfit ? sql`(${inRow} or ${inOutfit})` : inRow;
  return sql<WindowJson[]>`(
    select coalesce(json_agg(json_build_array(
      windowed.role, windowed.count, windowed.id, windowed.name,
      windowed.category, windowed.status, ${file.fileName}, ${file.version},
      ${file.variantKey}
    ) order by windowed.rank), '[]')
    from (
      select ranked.*, coalesce(max(case when ${isChosen} then ranked.rank end) over (partition by ranked.role), 0) as deepest
      from (
        select ${garment.id} as id, ${garment.name} as name,
          ${garment.category} as category, ${garment.status} as status,
          ${garment.photoId} as photo_id, ${roleOf} as role,
          (row_number() over (partition by ${roleOf} order by ${garment.id} desc))::int as rank,
          (count(*) over (partition by ${roleOf}))::int as count
        from ${garment}
        where ${cycleOf(ownerId, options.capsuleId)}
      ) ranked
    ) windowed
    left join ${file} on ${file.id} = windowed.photo_id
    where windowed.rank <= windowed.deepest + ${STRIP_PAGE}
  )`;
}

/** roleWindowsSql's value as the windows, each role's garments in cycle order. */
export function readRoleWindows(rows: readonly WindowJson[]): RoleWindow[] {
  const windows = new Map<GarmentRole, RoleWindow>();
  for (const [role, count, ...shown] of rows) {
    const window = windows.get(role) ?? { role, count, garments: [] };
    window.garments.push(readRowGarment(shown));
    windows.set(role, window);
  }
  return [...windows.values()];
}

/**
 * The next page of a role's cycle after the garment `before` (the strip's
 * sentinel): up to STRIP_PAGE garments, and whether more follow. Keyset
 * by id, the cycle's order, so a garment added meanwhile never shifts it.
 */
export async function roleGarmentsBefore(
  db: Db,
  ownerId: number,
  role: GarmentRole,
  options: { capsuleId?: number; before: number },
): Promise<{ garments: RowGarment[]; more: boolean }> {
  const rows = await db
    .select({
      id: garment.id,
      name: garment.name,
      category: garment.category,
      status: garment.status,
      photo: photoRefJson,
    })
    .from(garment)
    .leftJoin(file, eq(file.id, garment.photoId))
    .where(
      and(
        cycleOf(ownerId, options.capsuleId),
        inRole(role),
        lt(garment.id, options.before),
      ),
    )
    .orderBy(desc(garment.id))
    .limit(STRIP_PAGE + 1);
  return {
    garments: rows.slice(0, STRIP_PAGE),
    more: rows.length > STRIP_PAGE,
  };
}

/**
 * What the posted rows may carry beyond the closet (`StylingScope`, by
 * carryOf): the garments of the saved outfit they edit, and with Include
 * picks on, the garments offered to style with.
 */
export interface RowCarry {
  editingOutfitId: number | undefined;
  picks: boolean;
}

/**
 * The garments among `ids` the posted rows may carry, for every Styling
 * read of posted rows (stripsReads, ideaReads: the page, Shuffle, "Add
 * row", a refused Save's page): what an outfit's slots may name
 * (slotMayNameSql, the outfit writer's own rule, #335), so a row never
 * holds what Save would refuse, and a chosen pick survives every round
 * trip. Fewer than asked when one is someone else's, gone, or not
 * carried. A scalar subquery; read with readGarments.
 */
export function rowGarmentsSql(
  ownerId: number,
  ids: readonly number[],
  carry: RowCarry,
): SQL<RowGarmentJson[]> {
  return sql<RowGarmentJson[]>`(
    select coalesce(json_agg(${rowGarmentJson}), '[]')
    from ${garment}
    left join ${file} on ${eq(file.id, garment.photoId)}
    where ${and(
      eq(garment.ownerId, ownerId),
      inArray(garment.id, [...ids]),
      slotMayNameSql({
        outfitId: carry.editingOutfitId,
        // Into an edited outfit, a pick only while nothing holds it: the
        // writer's own condition, so a row never holds what Save refuses.
        offered:
          carry.picks &&
          (carry.editingOutfitId === undefined ||
            offeredIntoSql(carry.editingOutfitId)),
      }),
    )}
  )`;
}

/** rowGarmentsSql's garments (or an outfit's), each with its role. */
export function readGarments(rows: readonly RowGarmentJson[]): RoledGarment[] {
  return rows.map((row) => roled(readRowGarment(row)));
}

/**
 * A Save's garments: the requester's own among `ids`, whatever their
 * status, in the order posted (rows of one role keep theirs through
 * topToToe), for the slots' categories and the name. Not a judgement: the
 * outfit writer decides what the outfit may hold (insertSlots,
 * slotMayNameSql), under the owner lock. Fewer than asked only when one is
 * not theirs. One statement.
 */
export async function savedGarments(
  db: Db,
  ownerId: number,
  ids: readonly number[],
): Promise<RoledGarment[]> {
  if (ids.length === 0) return [];
  const { found } = await selectScalars(db, {
    found: sql<RowGarmentJson[]>`(
      select coalesce(json_agg(${rowGarmentJson}), '[]')
      from ${garment}
      left join ${file} on ${eq(file.id, garment.photoId)}
      where ${and(eq(garment.ownerId, ownerId), inArray(garment.id, [...ids]))}
    )`,
  });
  const byId = new Map(readGarments(found).map((g) => [g.id, g]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/** An outfit as Styling opens it (`?outfit=`). */
export interface SavedOutfit {
  id: number;
  name: string | null;
  garments: RoledGarment[];
}

interface SavedOutfitJson {
  id: number;
  name: string | null;
  garments: RowGarmentJson[];
}

/**
 * The owner's outfit `outfitId` as Styling opens it (`?outfit=`): its name
 * and the garments its slots hold, in slot order (empty slots, whose
 * garment was deleted, hold nothing to show). Null when the outfit is not
 * the owner's. A scalar subquery; read with readSavedOutfit.
 */
export function savedOutfitSql(
  outfitId: number,
  ownerId: number,
): SQL<SavedOutfitJson | null> {
  return sql<SavedOutfitJson | null>`(
    select json_build_object(
      'id', ${outfit.id},
      'name', ${outfit.name},
      'garments', (
        select coalesce(json_agg(${rowGarmentJson} order by ${outfitSlot.position}), '[]')
        from ${outfitSlot}
        inner join ${garment} on ${eq(garment.id, outfitSlot.garmentId)}
        left join ${file} on ${eq(file.id, garment.photoId)}
        where ${eq(outfitSlot.outfitId, outfit.id)}
      )
    )
    from ${outfit}
    where ${and(eq(outfit.id, outfitId), eq(outfit.ownerId, ownerId))}
  )`;
}

export function readSavedOutfit(
  json: SavedOutfitJson | null,
): SavedOutfit | undefined {
  return json
    ? { id: json.id, name: json.name, garments: readGarments(json.garments) }
    : undefined;
}

/**
 * Include picks (`?picks=1`, #335): the owner's garments offered to style
 * with (offeredToStyle: still wanted, not under a need set aside), which
 * join their role's strip first, badged "To buy". A need's options sit
 * side by side in Muse's rank (by need, newest first, then rank), then
 * the lone picks and the owner's own wishlist items, newest first. A
 * scalar subquery; read with readGarments.
 */
export function picksSql(ownerId: number): SQL<RowGarmentJson[]> {
  return sql<RowGarmentJson[]>`(
    select coalesce(json_agg(${rowGarmentJson} order by
      ${garment.suggestionGroupId} desc nulls last,
      ${garment.suggestionRank} nulls last,
      ${garment.id} desc), '[]')
    from ${garment}
    left join ${file} on ${eq(file.id, garment.photoId)}
    where ${and(eq(garment.ownerId, ownerId), offeredToStyle())}
  )`;
}
