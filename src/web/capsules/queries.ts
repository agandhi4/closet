import { and, asc, desc, eq, inArray, lte, type SQL, sql } from 'drizzle-orm';
import type { Db, Queryable } from '../../db/client';
import { capsule, capsuleGarment, file, garment } from '../../db/schema';
import { isUniqueViolation } from '../auth/queries';
import type { ImageRef } from '../files/image-url';

/**
 * Capsules' reads and writes (plan section 2): a capsule is a named subset
 * of one owner's garments. Every query names the wardrobe (owner) the
 * route resolved through authorizeWardrobe (src/web/sharing/access.ts); a
 * capsule outside it is a miss like a missing one, and the routes answer
 * 404 either way. The closet itself is not a capsule row: it is every
 * unarchived garment, and archived members are left out of every read here
 * while keeping their membership.
 */

export interface CapsuleRef {
  id: number;
  name: string;
}

export interface CapsuleDetail extends CapsuleRef {
  notes: string | null;
}

/** What the capsule form writes: the name trimmed and never blank, blank notes null. */
export interface CapsuleFields {
  name: string;
  notes: string | null;
}

/** A garment in a capsule card's strip. */
export interface StripGarment {
  id: number;
  name: string | null;
  photo: ImageRef | null;
}

export interface CapsuleCard extends CapsuleRef {
  /** Unarchived members. */
  count: number;
  /** The newest few unarchived members (CARD_STRIP). */
  strip: StripGarment[];
}

/** Thumbs on a capsule card (and the closet's): four fit a phone's width. */
export const CARD_STRIP = 4;

/**
 * "The garment is in capsule `capsuleId`", for a query over `garment`: the
 * wardrobe grid's `?capsule=`, the outfit builder's cycles, and the outfit
 * gallery's pool (#9) when it comes. Safe on any wardrobe without checking
 * whose capsule it is: a capsule only ever holds its owner's garments
 * (changeMembership), so on another wardrobe it matches nothing. A route
 * that shows the capsule's name still looks it up (findCapsule).
 */
export function inCapsule(capsuleId: number): SQL {
  return sql`${garment.id} in (select ${capsuleGarment.garmentId} from ${capsuleGarment} where ${capsuleGarment.capsuleId} = ${capsuleId})`;
}

const byName = [asc(sql`lower(${capsule.name})`), asc(capsule.id)];

/** The wardrobe's capsules by name: the grid's filter and the garment page's toggles. */
export function capsuleNames(db: Db, ownerId: number): Promise<CapsuleRef[]> {
  return db
    .select({ id: capsule.id, name: capsule.name })
    .from(capsule)
    .where(eq(capsule.ownerId, ownerId))
    .orderBy(...byName);
}

/** The capsule in `ownerId`'s wardrobe, or undefined. */
export async function findCapsule(
  db: Db,
  id: number,
  ownerId: number,
): Promise<CapsuleDetail | undefined> {
  const [row] = await db
    .select({ id: capsule.id, name: capsule.name, notes: capsule.notes })
    .from(capsule)
    .where(and(eq(capsule.id, id), eq(capsule.ownerId, ownerId)));
  return row;
}

/**
 * The list page: every capsule of the wardrobe by name, with its count of
 * unarchived members and the newest few of them. Two statements, whatever
 * the number of capsules: the counts (grouped), and the strips (ranked per
 * capsule, only the first CARD_STRIP read).
 */
export async function listCapsules(
  db: Db,
  ownerId: number,
): Promise<CapsuleCard[]> {
  const [capsules, strips] = await Promise.all([
    db
      .select({
        id: capsule.id,
        name: capsule.name,
        count: sql<number>`count(${garment.id})::int`,
      })
      .from(capsule)
      .leftJoin(capsuleGarment, eq(capsuleGarment.capsuleId, capsule.id))
      .leftJoin(
        garment,
        and(
          eq(garment.id, capsuleGarment.garmentId),
          eq(garment.archived, false),
        ),
      )
      .where(eq(capsule.ownerId, ownerId))
      .groupBy(capsule.id)
      .orderBy(...byName),
    capsuleStrips(db, ownerId),
  ]);
  return capsules.map((row) => ({ ...row, strip: strips.get(row.id) ?? [] }));
}

async function capsuleStrips(
  db: Db,
  ownerId: number,
): Promise<Map<number, StripGarment[]>> {
  const ranked = db
    .select({
      capsuleId: capsuleGarment.capsuleId,
      id: garment.id,
      name: garment.name,
      photoId: garment.photoId,
      rank: sql<number>`(row_number() over (partition by ${capsuleGarment.capsuleId} order by ${garment.id} desc))::int`.as(
        'rank',
      ),
    })
    .from(capsuleGarment)
    .innerJoin(capsule, eq(capsule.id, capsuleGarment.capsuleId))
    .innerJoin(garment, eq(garment.id, capsuleGarment.garmentId))
    .where(and(eq(capsule.ownerId, ownerId), eq(garment.archived, false)))
    .as('ranked');
  const rows = await db
    .select({
      capsuleId: ranked.capsuleId,
      id: ranked.id,
      name: ranked.name,
      photo: { fileName: file.fileName, version: file.version },
    })
    .from(ranked)
    .leftJoin(file, eq(file.id, ranked.photoId))
    .where(lte(ranked.rank, CARD_STRIP))
    .orderBy(asc(ranked.capsuleId), asc(ranked.rank));
  const strips = new Map<number, StripGarment[]>();
  for (const { capsuleId, ...shown } of rows) {
    strips.set(capsuleId, [...(strips.get(capsuleId) ?? []), shown]);
  }
  return strips;
}

/** The closet's card on the list page: every unarchived garment. */
export async function closetCard(
  db: Db,
  ownerId: number,
): Promise<{ count: number; strip: StripGarment[] }> {
  const inCloset = and(
    eq(garment.ownerId, ownerId),
    eq(garment.archived, false),
  );
  const [count, strip] = await Promise.all([
    db.$count(garment, inCloset),
    db
      .select({
        id: garment.id,
        name: garment.name,
        photo: { fileName: file.fileName, version: file.version },
      })
      .from(garment)
      .leftJoin(file, eq(file.id, garment.photoId))
      .where(inCloset)
      .orderBy(desc(garment.id))
      .limit(CARD_STRIP),
  ]);
  return { count, strip };
}

/**
 * The picker's checked tiles: the ids of the capsule's members (archived
 * ones too; the grid decides what it shows). Empty for a capsule outside
 * `ownerId`'s wardrobe.
 */
export async function memberIds(
  db: Db,
  capsuleId: number,
  ownerId: number,
): Promise<Set<number>> {
  const rows = await db
    .select({ id: capsuleGarment.garmentId })
    .from(capsuleGarment)
    .innerJoin(capsule, eq(capsule.id, capsuleGarment.capsuleId))
    .where(and(eq(capsule.id, capsuleId), eq(capsule.ownerId, ownerId)));
  return new Set(rows.map((row) => row.id));
}

export interface GarmentCapsule extends CapsuleRef {
  member: boolean;
}

/** The garment page's "In capsules": every capsule of the wardrobe, by name, and whether the garment is in it. */
export function capsulesOfGarment(
  db: Db,
  ownerId: number,
  garmentId: number,
): Promise<GarmentCapsule[]> {
  return db
    .select({
      id: capsule.id,
      name: capsule.name,
      member: sql<boolean>`${capsuleGarment.garmentId} is not null`,
    })
    .from(capsule)
    .leftJoin(
      capsuleGarment,
      and(
        eq(capsuleGarment.capsuleId, capsule.id),
        eq(capsuleGarment.garmentId, garmentId),
      ),
    )
    .where(eq(capsule.ownerId, ownerId))
    .orderBy(...byName);
}

/**
 * The owner already has a capsule by this name, whatever its case
 * (capsule_owner_id_lower_name_unique). The index is the rule, so a
 * concurrent save cannot slip past a check made first.
 */
export type NameTaken = 'name-taken';

/**
 * Creates a capsule in `ownerId`'s wardrobe (the form, the seed): its id,
 * or 'name-taken'. In a savepoint, so a caller's transaction (the seed's)
 * survives the refusal.
 */
export async function createCapsule(
  db: Queryable,
  ownerId: number,
  fields: CapsuleFields,
): Promise<number | NameTaken> {
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(capsule)
        .values({ ownerId, ...fields })
        .returning({ id: capsule.id });
      return row.id;
    });
  } catch (error) {
    if (isUniqueViolation(error)) return 'name-taken';
    throw error;
  }
}

/** Renames it: 'not-found' outside `ownerId`'s wardrobe, 'name-taken' for another capsule's name. */
export async function updateCapsule(
  db: Db,
  id: number,
  ownerId: number,
  fields: CapsuleFields,
): Promise<'updated' | 'not-found' | NameTaken> {
  try {
    const updated = await db
      .update(capsule)
      .set(fields)
      .where(and(eq(capsule.id, id), eq(capsule.ownerId, ownerId)))
      .returning({ id: capsule.id });
    return updated.length > 0 ? 'updated' : 'not-found';
  } catch (error) {
    if (isUniqueViolation(error)) return 'name-taken';
    throw error;
  }
}

/** Deletes it (its membership cascades, its garments stay); false when not in `ownerId`'s wardrobe. */
export async function deleteCapsule(
  db: Db,
  id: number,
  ownerId: number,
): Promise<boolean> {
  const deleted = await db
    .delete(capsule)
    .where(and(eq(capsule.id, id), eq(capsule.ownerId, ownerId)))
    .returning({ id: capsule.id });
  return deleted.length > 0;
}

/** Every pairing of these capsules with these garments. */
export interface MembershipSet {
  capsuleIds: number[];
  garmentIds: number[];
}

export interface MembershipChange {
  add?: MembershipSet;
  remove?: MembershipSet;
}

/**
 * The one writer of capsule_garment: removes every pairing in `remove`,
 * then adds every pairing in `add` (one already there is kept), in one
 * transaction. Only capsules and garments of `ownerId`'s wardrobe take
 * part: any other id is dropped, so a capsule never holds another
 * wardrobe's garment. Both sides are locked FOR SHARE, so a capsule or
 * garment deleted meanwhile waits for this to commit rather than failing a
 * foreign key halfway. The picker (a capsule and the tiles it showed), the
 * garment page's toggles (a garment and the capsules it listed) and the
 * seed all go through it.
 */
export function changeMembership(
  db: Queryable,
  ownerId: number,
  change: MembershipChange,
): Promise<{ added: number; removed: number }> {
  return db.transaction(async (tx) => {
    const sets = [change.add, change.remove].flatMap((set) => set ?? []);
    const capsules = await ownedCapsules(
      tx,
      ownerId,
      sets.flatMap((set) => set.capsuleIds),
    );
    const garments = await ownedGarments(
      tx,
      ownerId,
      sets.flatMap((set) => set.garmentIds),
    );
    // Each id once: a form may post one twice.
    const owned = (set: MembershipSet | undefined): MembershipSet => ({
      capsuleIds: [...new Set(set?.capsuleIds)].filter((id) =>
        capsules.has(id),
      ),
      garmentIds: [...new Set(set?.garmentIds)].filter((id) =>
        garments.has(id),
      ),
    });
    const remove = owned(change.remove);
    const add = owned(change.add);
    let removed = 0;
    if (remove.capsuleIds.length > 0 && remove.garmentIds.length > 0) {
      removed = (
        await tx
          .delete(capsuleGarment)
          .where(
            and(
              inArray(capsuleGarment.capsuleId, remove.capsuleIds),
              inArray(capsuleGarment.garmentId, remove.garmentIds),
            ),
          )
          .returning({ capsuleId: capsuleGarment.capsuleId })
      ).length;
    }
    let added = 0;
    if (add.capsuleIds.length > 0 && add.garmentIds.length > 0) {
      added = (
        await tx
          .insert(capsuleGarment)
          .values(
            add.capsuleIds.flatMap((capsuleId) =>
              add.garmentIds.map((garmentId) => ({ capsuleId, garmentId })),
            ),
          )
          .onConflictDoNothing()
          .returning({ capsuleId: capsuleGarment.capsuleId })
      ).length;
    }
    return { added, removed };
  });
}

/** Which of `ids` are capsules of `ownerId`'s wardrobe, locked FOR SHARE. */
async function ownedCapsules(
  tx: Queryable,
  ownerId: number,
  ids: number[],
): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const rows = await tx
    .select({ id: capsule.id })
    .from(capsule)
    .where(and(eq(capsule.ownerId, ownerId), inArray(capsule.id, ids)))
    .for('share');
  return new Set(rows.map((row) => row.id));
}

/** Which of `ids` are garments of `ownerId`'s wardrobe, locked FOR SHARE. */
async function ownedGarments(
  tx: Queryable,
  ownerId: number,
  ids: number[],
): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const rows = await tx
    .select({ id: garment.id })
    .from(garment)
    .where(and(eq(garment.ownerId, ownerId), inArray(garment.id, ids)))
    .for('share');
  return new Set(rows.map((row) => row.id));
}
