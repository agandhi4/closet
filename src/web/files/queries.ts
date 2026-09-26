import { eq } from 'drizzle-orm';
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
