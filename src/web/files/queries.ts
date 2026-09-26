import { eq, sql } from 'drizzle-orm';
import type { InitialCutoutColumns } from '../../cutout/state';
import type { Db, Queryable } from '../../db/client';
import { file } from '../../db/schema';

/**
 * A photo's `file` row as Photos returns it after writing the bytes, not yet
 * inserted: the caller commits it in the transaction that also points a
 * garment at it (insertPhotoRow with its tx), and calls deleteVariants if
 * that transaction fails. Version starts at the column default, 1.
 */
export interface NewPhotoRow {
  fileName: string;
  shareableId: string;
  /** ISO timestamp as text, as the column has always held it. */
  createdOn: string;
  createdById: number;
}

/**
 * Inserts the row inside the caller's transaction; returns its id. The
 * cutout columns (initialCutoutState) default to `none`.
 */
export async function insertPhotoRow(
  q: Queryable,
  row: NewPhotoRow & Partial<InitialCutoutColumns>,
): Promise<number> {
  const [inserted] = await q
    .insert(file)
    .values(row)
    .returning({ id: file.id });
  return inserted.id;
}

/**
 * Serializes every transaction that decides the fate of a stored name that
 * may have no row yet (a link import's pending photo: claimed by a garment
 * save, or discarded when another photo is picked). A row cannot be locked
 * before it exists, so the name itself is: a transaction-scoped advisory
 * lock, released at commit or rollback.
 */
export async function lockPhotoName(
  tx: Queryable,
  fileName: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`closet:photo:${fileName}`}))`,
  );
}

export async function photoRowExists(
  q: Queryable,
  fileName: string,
): Promise<boolean> {
  const [row] = await q
    .select({ id: file.id })
    .from(file)
    .where(eq(file.fileName, fileName))
    .limit(1);
  return row !== undefined;
}

/** The stored name behind a share link's image (the watermark route). */
export async function findPhotoByShareableId(
  db: Db,
  shareableId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ fileName: file.fileName })
    .from(file)
    .where(eq(file.shareableId, shareableId))
    .limit(1);
  return row?.fileName;
}
