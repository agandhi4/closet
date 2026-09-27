import {
  and,
  asc,
  desc,
  eq,
  inArray,
  lt,
  notInArray,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { Db } from '../../db/client';
import { file, garment, outfit, outfitSlot } from '../../db/schema';
import {
  builtInCategoriesOf,
  categoryRole,
  GARMENT_ROLES,
  type GarmentRole,
} from '../../wardrobe/properties';
import { inCapsule } from '../capsules/queries';
import { inCloset, ownedGarment } from '../wardrobe/status';
import { type RoleWindow, type RowGarment, STRIP_PAGE } from './rows';

/**
 * Styling's reads (#42). Every function reads one wardrobe, `ownerId`: the
 * requester's own, or a wardrobe shared with them that the route
 * authorized (authorizeWardrobe, view). What an outfit holds is only ever
 * read for its owner (savedGarments); writes go through the outfit writers
 * (src/web/outfits/queries.ts, src/web/gallery/pick.ts).
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

const photoColumns = { fileName: file.fileName, version: file.version };

/**
 * Every role the wardrobe (or the capsule) has closet garments of, each
 * with its count and the window a page shows: newest first, STRIP_PAGE
 * garments past the deepest of `selected` in that role (the rows' chosen
 * garments, so a chosen one deep in a long cycle is on the strip). One
 * statement, whatever the wardrobe holds: the ranks and counts are window
 * functions, and only the window's rows come back.
 */
export async function roleWindows(
  db: Db,
  ownerId: number,
  options: { capsuleId?: number; selected: readonly number[] },
): Promise<RoleWindow[]> {
  const selected = sql`array[${sql.join(
    options.selected.map((id) => sql`${id}`),
    sql`, `,
  )}]::int[]`;
  const ranked = db.$with('ranked').as(
    db
      .select({
        id: garment.id,
        name: garment.name,
        category: garment.category,
        status: garment.status,
        photoId: sql<number | null>`${garment.photoId}`.as('photo_id'),
        role: sql<GarmentRole>`${roleOf}`.as('role'),
        rank: sql<number>`(row_number() over (partition by ${roleOf} order by ${garment.id} desc))::int`.as(
          'rank',
        ),
        count: sql<number>`(count(*) over (partition by ${roleOf}))::int`.as(
          'count',
        ),
      })
      .from(garment)
      .where(cycleOf(ownerId, options.capsuleId)),
  );
  const deepest = db
    .select({
      id: ranked.id,
      name: ranked.name,
      category: ranked.category,
      status: ranked.status,
      photoId: ranked.photoId,
      role: ranked.role,
      rank: ranked.rank,
      count: ranked.count,
      deepest:
        sql<number>`coalesce(max(case when ${ranked.id} = any(${selected}) then ${ranked.rank} end) over (partition by ${ranked.role}), 0)`.as(
          'deepest',
        ),
    })
    .from(ranked)
    .as('windowed');
  const rows = await db
    .with(ranked)
    .select({
      id: deepest.id,
      name: deepest.name,
      category: deepest.category,
      status: deepest.status,
      role: deepest.role,
      count: deepest.count,
      photo: photoColumns,
    })
    .from(deepest)
    .leftJoin(file, eq(file.id, deepest.photoId))
    .where(sql`${deepest.rank} <= ${deepest.deepest} + ${STRIP_PAGE}`)
    .orderBy(asc(deepest.rank));
  const windows = new Map<GarmentRole, RoleWindow>();
  for (const { role, count, ...shown } of rows) {
    const window = windows.get(role) ?? { role, count, garments: [] };
    window.garments.push(shown);
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
      photo: photoColumns,
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

/** A garment with the role its category plays. */
export type RoledGarment = RowGarment & { role: GarmentRole };

function withRole(garments: RowGarment[]): RoledGarment[] {
  return garments.map((g) => ({ ...g, role: categoryRole(g.category) }));
}

/**
 * The wardrobe's owned garments (in the closet or archived) among `ids`:
 * what a posted row may hold. Fewer than asked when any is someone else's,
 * a wishlist item or gone.
 */
export async function ownGarments(
  db: Db,
  ownerId: number,
  ids: readonly number[],
): Promise<RoledGarment[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: garment.id,
      name: garment.name,
      category: garment.category,
      status: garment.status,
      photo: photoColumns,
    })
    .from(garment)
    .leftJoin(file, eq(file.id, garment.photoId))
    .where(
      and(
        eq(garment.ownerId, ownerId),
        inArray(garment.id, [...ids]),
        ownedGarment(),
      ),
    );
  return withRole(rows);
}

/**
 * The owner's outfit `outfitId` as Styling opens it (`?outfit=`): its name
 * and the garments its slots hold, in slot order (empty slots, whose
 * garment was deleted, hold nothing to show). Undefined when the outfit is
 * not the owner's. One statement.
 */
export async function savedGarments(
  db: Db,
  outfitId: number,
  ownerId: number,
): Promise<
  { id: number; name: string | null; garments: RoledGarment[] } | undefined
> {
  const found = await db.query.outfit.findFirst({
    columns: { id: true, name: true },
    where: and(eq(outfit.id, outfitId), eq(outfit.ownerId, ownerId)),
    with: {
      slots: {
        columns: {},
        orderBy: asc(outfitSlot.position),
        with: {
          garment: {
            columns: { id: true, name: true, category: true, status: true },
            with: { photo: { columns: { fileName: true, version: true } } },
          },
        },
      },
    },
  });
  if (!found) return undefined;
  return {
    id: found.id,
    name: found.name,
    garments: withRole(
      found.slots.flatMap(({ garment: held }) => (held ? [held] : [])),
    ),
  };
}
