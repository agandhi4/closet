import { and, desc, eq, max, type SQL, sql } from 'drizzle-orm';
import type { IsoDate } from '../../calendar-date';
import { initialCutoutState } from '../../cutout/state';
import type { Db, Queryable } from '../../db/client';
import { selectScalars } from '../../db/select-scalars';
import { file, inspiration, inspirationPiece } from '../../db/schema';
import type {
  GarmentColor,
  InspirationPieceRole,
  Pattern,
} from '../../wardrobe/properties';
import type { LookPiece } from '../../wardrobe/recreate';
import type { PrivatePhoto } from '../files/image-url';
import {
  readRecreateInputs,
  type RecreatePoolGarment,
  recreateInputsSql,
} from '../gallery/queries';
import type { OutfitRule } from '../../wardrobe/outfit-rules';
import { takePendingPhoto } from '../files/pending-photos';
import {
  insertPhotoRow,
  lockPhotoName,
  type NewPhotoRow,
} from '../files/queries';
import { HttpError } from '../errors';
import { NotFound } from '../refusals';

/**
 * Saved looks (#22; docs/plans/2026-11-13-inspiration-library.md): the
 * owner's own, like the style profile. Every function is scoped to the
 * owner, and nothing reaches them through a share: another user's look is
 * NotFound like an unknown id. The one writer of `inspiration` is here
 * (saveInspiration, saveInspirationWithPendingPhoto, setInspirationPhoto,
 * updateInspirationText, deleteInspiration), and of `inspiration_piece`
 * (addInspirationPiece, updateInspirationPiece, deleteInspirationPiece);
 * the bytes are Photos', stored before and unlinked after by the callers
 * (writes.ts, the commit contract).
 */

/** The title's cap: the column's (varchar 255). */
export const INSPIRATION_TITLE_MAX = 255;
/** The note's cap, the route's: a few paragraphs of what caught the eye. */
export const INSPIRATION_NOTE_MAX = 2000;

/** A look as the list and its page draw it. */
export interface InspirationSummary {
  id: number;
  title: string | null;
  sourceUrl: string | null;
  /** Null for a link saved without a photo. */
  photo: PrivatePhoto | null;
}

/** A piece of a look as the owner read it, at its place in the look. */
export interface StoredPiece extends LookPiece {
  position: number;
}

/** The most pieces a look holds: an outfit's worth, with room for accessories. */
export const INSPIRATION_MAX_PIECES = 12;

export interface InspirationDetail extends InspirationSummary {
  note: string | null;
  /** In their order (position). */
  pieces: StoredPiece[];
}

export interface InspirationText {
  title: string | null;
  note: string | null;
}

const SUMMARY_COLUMNS = {
  id: inspiration.id,
  title: inspiration.title,
  sourceUrl: inspiration.sourceUrl,
  fileName: file.fileName,
  version: file.version,
};

function photoOf(row: {
  fileName: string | null;
  version: number | null;
}): PrivatePhoto | null {
  return row.fileName === null
    ? null
    : { fileName: row.fileName, version: row.version ?? 1 };
}

/**
 * The owner's looks, newest first: the Inspiration tab's one statement
 * after the session's (inspiration_owner_id_id_index, read backward).
 */
export async function listInspirations(
  db: Db,
  ownerId: number,
): Promise<InspirationSummary[]> {
  const rows = await db
    .select(SUMMARY_COLUMNS)
    .from(inspiration)
    .leftJoin(file, eq(file.id, inspiration.photoId))
    .where(eq(inspiration.ownerId, ownerId))
    .orderBy(desc(inspiration.id));
  return rows.map(({ fileName, version, ...row }) => ({
    ...row,
    photo: photoOf({ fileName, version }),
  }));
}

type PieceJson = [
  position: number,
  role: InspirationPieceRole,
  type: string | null,
  colors: GarmentColor[],
  pattern: Pattern | null,
];

interface LookJson {
  id: number;
  title: string | null;
  note: string | null;
  sourceUrl: string | null;
  fileName: string | null;
  version: number | null;
  pieces: PieceJson[];
}

/**
 * The owner's look `id` with its photo and its pieces, as a scalar
 * subquery (null when it is not theirs), so a page reads it in one
 * statement with whatever else it needs (the match view: the closet).
 */
function lookJsonSql(id: number, ownerId: number): SQL<LookJson | null> {
  return sql<LookJson | null>`(
    select json_build_object(
      'id', ${inspiration.id},
      'title', ${inspiration.title},
      'note', ${inspiration.note},
      'sourceUrl', ${inspiration.sourceUrl},
      'fileName', ${file.fileName},
      'version', ${file.version},
      'pieces', (
        select coalesce(json_agg(json_build_array(
          ${inspirationPiece.position}, ${inspirationPiece.role},
          ${inspirationPiece.type}, ${inspirationPiece.colors},
          ${inspirationPiece.pattern}
        ) order by ${inspirationPiece.position}), '[]')
        from ${inspirationPiece}
        where ${eq(inspirationPiece.inspirationId, inspiration.id)}
      )
    )
    from ${inspiration}
    left join ${file} on ${eq(file.id, inspiration.photoId)}
    where ${and(eq(inspiration.id, id), eq(inspiration.ownerId, ownerId))}
  )`;
}

function readLook(json: LookJson | null): InspirationDetail {
  if (!json) throw new NotFound('inspiration');
  const { fileName, version, pieces, ...look } = json;
  return {
    ...look,
    photo: photoOf({ fileName, version }),
    pieces: pieces.map(([position, role, type, colors, pattern]) => ({
      position,
      role,
      type,
      colors,
      pattern,
    })),
  };
}

/** The owner's look `id` with its pieces, one statement; NotFound when it is not theirs. */
export async function findInspiration(
  db: Db,
  id: number,
  ownerId: number,
): Promise<InspirationDetail> {
  const { look } = await selectScalars(db, { look: lookJsonSql(id, ownerId) });
  return readLook(look);
}

/** What the match view judges: the look, and the closet it is recreated from. */
export interface RecreateInputs {
  look: InspirationDetail;
  closet: RecreatePoolGarment[];
  avoid: [number, number][];
  rules: OutfitRule[];
}

/**
 * The owner's look `id` and what "Recreate this look" matches it against
 * (recreateInputsSql: the closet, the avoided pairs, the outfit rules), in
 * one statement; NotFound when the look is not theirs. The owner's own
 * closet only, whatever is shared with them, as ideas are.
 */
export async function recreateInputs(
  db: Db,
  id: number,
  ownerId: number,
  today: IsoDate,
): Promise<RecreateInputs> {
  const { look, ...inputs } = await selectScalars(db, {
    look: lookJsonSql(id, ownerId),
    ...recreateInputsSql(ownerId, today),
  });
  return { look: readLook(look), ...readRecreateInputs(inputs) };
}

/** What a new look is saved with besides its photo. */
export interface NewInspiration {
  title: string | null;
  sourceUrl: string | null;
}

/**
 * A new look of the owner's: `photo` (bytes already stored, or null for a
 * link alone) gets its `file` row, with no cutout (`unwanted`: a look is a
 * whole picture, and a cutout would remove the outfit with the background),
 * in one transaction with the look pointing at it; a link alone is one
 * statement. Answers the look's id. With saveInspirationWithPendingPhoto,
 * the one way a look is created (writes.ts).
 */
export function saveInspiration(
  db: Db,
  ownerId: number,
  photo: NewPhotoRow | null,
  fields: NewInspiration,
): Promise<number> {
  return photo
    ? db.transaction((tx) => insertInspiration(tx, ownerId, photo, fields))
    : insertInspiration(db, ownerId, null, fields);
}

/**
 * A new look with the pending photo `fileName` the owner just stored (a
 * pasted link's, importLink), in one transaction: the pending row taken
 * under the name's lock (as a garment's save claims one, so a discard, an
 * eviction or reconciliation either went first or finds it gone), then the
 * `file` row and the look. `photo` is its row as Photos built it, after
 * checking its bytes outside the transaction (#141). Undefined, writing
 * nothing, when it is no longer the owner's to claim; its bytes are then
 * whoever took the pending row's to delete.
 */
export function saveInspirationWithPendingPhoto(
  db: Db,
  ownerId: number,
  photo: NewPhotoRow,
  fields: NewInspiration,
): Promise<number | undefined> {
  return db.transaction(async (tx) => {
    await lockPhotoName(tx, photo.fileName);
    const scope = { userId: ownerId, ownerId };
    if (!(await takePendingPhoto(tx, photo.fileName, scope))) return undefined;
    return insertInspiration(tx, ownerId, photo, fields);
  });
}

async function insertInspiration(
  q: Queryable,
  ownerId: number,
  photo: NewPhotoRow | null,
  fields: NewInspiration,
): Promise<number> {
  const photoId =
    photo &&
    (await insertPhotoRow(q, { ...photo, ...initialCutoutState('unwanted') }));
  const [created] = await q
    .insert(inspiration)
    .values({ ownerId, ...fields, photoId })
    .returning({ id: inspiration.id });
  return created.id;
}

/**
 * Makes `photo` (bytes already stored) the owner's look's photo, in one
 * transaction: its row inserted (`unwanted`, as saveInspiration), the look
 * pointed at it, the photo it replaces deleted. Answers the replaced
 * photo's name for the caller to unlink after commit (null for a look that
 * had none); NotFound, writing nothing, when the look is not the owner's.
 * The look's row is locked first, so two uploads take turns and the second
 * replaces the first.
 */
export function setInspirationPhoto(
  db: Db,
  id: number,
  ownerId: number,
  photo: NewPhotoRow,
): Promise<{ replaced: string | null }> {
  return db.transaction(async (tx) => {
    const [look] = await tx
      .select({ photoId: inspiration.photoId, fileName: file.fileName })
      .from(inspiration)
      .leftJoin(file, eq(file.id, inspiration.photoId))
      .where(and(eq(inspiration.id, id), eq(inspiration.ownerId, ownerId)))
      .for('update', { of: inspiration });
    if (!look) throw new NotFound('inspiration');
    const photoId = await insertPhotoRow(tx, {
      ...photo,
      ...initialCutoutState('unwanted'),
    });
    await tx.update(inspiration).set({ photoId }).where(eq(inspiration.id, id));
    if (look.photoId !== null) {
      await tx.delete(file).where(eq(file.id, look.photoId));
    }
    return { replaced: look.fileName };
  });
}

/** The owner's look's title and note (the page's autosave); NotFound when not theirs. */
export async function updateInspirationText(
  db: Db,
  id: number,
  ownerId: number,
  text: InspirationText,
): Promise<void> {
  const updated = await db
    .update(inspiration)
    .set(text)
    .where(and(eq(inspiration.id, id), eq(inspiration.ownerId, ownerId)))
    .returning({ id: inspiration.id });
  if (updated.length === 0) throw new NotFound('inspiration');
}

/**
 * Deletes the owner's look and its photo's `file` row in one transaction;
 * answers the photo's name for the caller to unlink after commit (null for
 * a link alone). NotFound when the look is not the owner's. Its pieces go
 * with it (the foreign key's cascade).
 */
export function deleteInspiration(
  db: Db,
  id: number,
  ownerId: number,
): Promise<{ photo: string | null }> {
  return db.transaction(async (tx) => {
    const [deleted] = await tx
      .delete(inspiration)
      .where(and(eq(inspiration.id, id), eq(inspiration.ownerId, ownerId)))
      .returning({ photoId: inspiration.photoId });
    if (!deleted) throw new NotFound('inspiration');
    if (deleted.photoId === null) return { photo: null };
    const [photo] = await tx
      .delete(file)
      .where(eq(file.id, deleted.photoId))
      .returning({ fileName: file.fileName });
    return { photo: photo.fileName };
  });
}

/**
 * Whether `fileName` is the photo of one of the owner's looks: the one
 * question GET /inspiration/photo/* asks before streaming it (anyone
 * else's is a 404, like a missing photo).
 */
export async function isOwnInspirationPhoto(
  db: Db,
  fileName: string,
  ownerId: number,
): Promise<boolean> {
  const [row] = await db
    .select({ id: inspiration.id })
    .from(inspiration)
    .innerJoin(file, eq(file.id, inspiration.photoId))
    .where(and(eq(file.fileName, fileName), eq(inspiration.ownerId, ownerId)))
    .limit(1);
  return row !== undefined;
}

/** The owner's look `id`, locked for a change to its pieces; NotFound when not theirs. */
async function lockOwnLook(q: Queryable, id: number, ownerId: number) {
  const [look] = await q
    .select({ id: inspiration.id })
    .from(inspiration)
    .where(and(eq(inspiration.id, id), eq(inspiration.ownerId, ownerId)))
    .for('update');
  if (!look) throw new NotFound('inspiration');
}

/**
 * A new piece at the end of the owner's look `id`; answers its position.
 * The look's row is locked first, so two adds take turns for the next
 * position. NotFound when the look is not the owner's; a 400 past
 * INSPIRATION_MAX_PIECES (the page offers no add there).
 */
export function addInspirationPiece(
  db: Db,
  id: number,
  ownerId: number,
  piece: LookPiece,
): Promise<number> {
  return db.transaction(async (tx) => {
    await lockOwnLook(tx, id, ownerId);
    const [{ last, count }] = await tx
      .select({
        last: max(inspirationPiece.position),
        count: sql<number>`count(*)::int`,
      })
      .from(inspirationPiece)
      .where(eq(inspirationPiece.inspirationId, id));
    if (count >= INSPIRATION_MAX_PIECES) {
      throw new HttpError(400, undefined, {
        logDetail: `inspiration ${id} already has ${count} pieces`,
      });
    }
    const position = last === null ? 0 : last + 1;
    await tx
      .insert(inspirationPiece)
      .values({ inspirationId: id, position, ...pieceColumns(piece) });
    return position;
  });
}

function pieceColumns(piece: LookPiece) {
  return {
    role: piece.role,
    type: piece.type,
    colors: [...piece.colors],
    pattern: piece.pattern,
  };
}

/** The owner's look `id`'s piece at `position`: the condition every piece write is scoped by. */
function ownPiece(id: number, position: number, ownerId: number): SQL {
  return and(
    eq(inspirationPiece.inspirationId, id),
    eq(inspirationPiece.position, position),
    sql`exists (select 1 from ${inspiration} where ${and(
      eq(inspiration.id, inspirationPiece.inspirationId),
      eq(inspiration.ownerId, ownerId),
    )})`,
  )!;
}

/**
 * What the owner reads in a piece now (the piece's autosave). The garment
 * chosen for it is cleared: it was chosen for what the piece was.
 * NotFound when it is not a piece of one of their looks.
 */
export async function updateInspirationPiece(
  db: Db,
  id: number,
  position: number,
  ownerId: number,
  piece: LookPiece,
): Promise<void> {
  const updated = await db
    .update(inspirationPiece)
    .set({ ...pieceColumns(piece), matchedGarmentId: null })
    .where(ownPiece(id, position, ownerId))
    .returning({ position: inspirationPiece.position });
  if (updated.length === 0) throw new NotFound('inspirationPiece');
}

/** Removes a piece of the owner's look; the rest keep their positions. NotFound when not theirs. */
export async function deleteInspirationPiece(
  db: Db,
  id: number,
  position: number,
  ownerId: number,
): Promise<void> {
  const deleted = await db
    .delete(inspirationPiece)
    .where(ownPiece(id, position, ownerId))
    .returning({ position: inspirationPiece.position });
  if (deleted.length === 0) throw new NotFound('inspirationPiece');
}
