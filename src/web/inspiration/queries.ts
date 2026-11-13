import { and, desc, eq } from 'drizzle-orm';
import { initialCutoutState } from '../../cutout/state';
import type { Db, Queryable } from '../../db/client';
import { file, inspiration } from '../../db/schema';
import type { PrivatePhoto } from '../files/image-url';
import { takePendingPhoto } from '../files/pending-photos';
import {
  insertPhotoRow,
  lockPhotoName,
  type NewPhotoRow,
} from '../files/queries';
import { NotFound } from '../refusals';

/**
 * Saved looks (#22; docs/plans/2026-11-13-inspiration-library.md): the
 * owner's own, like the style profile. Every function is scoped to the
 * owner, and nothing reaches them through a share: another user's look is
 * NotFound like an unknown id. The one writer of `inspiration` is here
 * (saveInspiration, saveInspirationWithPendingPhoto, setInspirationPhoto,
 * updateInspirationText, deleteInspiration); the bytes are Photos', stored before and unlinked
 * after by the callers (writes.ts, the commit contract).
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

export interface InspirationDetail extends InspirationSummary {
  note: string | null;
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

/** The owner's look `id`; NotFound when it is not theirs. */
export async function findInspiration(
  db: Db,
  id: number,
  ownerId: number,
): Promise<InspirationDetail> {
  const [row] = await db
    .select({ ...SUMMARY_COLUMNS, note: inspiration.note })
    .from(inspiration)
    .leftJoin(file, eq(file.id, inspiration.photoId))
    .where(and(eq(inspiration.id, id), eq(inspiration.ownerId, ownerId)));
  if (!row) throw new NotFound('inspiration');
  const { fileName, version, ...rest } = row;
  return { ...rest, photo: photoOf({ fileName, version }) };
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
