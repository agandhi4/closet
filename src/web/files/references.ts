import { eq, type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Queryable } from '../../db/client';
import { file, garment, selfie } from '../../db/schema';

/**
 * What points at a photo's `file` row: a garment's photo and an outfit
 * selfie (#19). The one list. Reconciliation deletes a row (and its bytes)
 * that nothing here references once it is a day old
 * (src/maintenance/reconcile.ts), so a new table with a photo column must
 * be added here, or every one of its photos is deleted the night after it
 * was stored.
 */
export function photoIsReferenced(fileId: AnyPgColumn): SQL<boolean> {
  // Uncorrelated on purpose: in a single-table select drizzle writes the
  // columns of a SQL field without their table, so a correlated
  // `garment.photo_id = file.id` would compare garment.photo_id with
  // garment.id. The nulls are left out, or `not in` would be null.
  return sql<boolean>`(${fileId} in (select ${garment.photoId} from ${garment} where ${garment.photoId} is not null union all select ${selfie.photoId} from ${selfie}))`;
}

/**
 * Whether the stored name is a photo only its owner may see: an outfit
 * selfie, served by the session-checked GET /selfies/* (src/web/selfies)
 * and refused by the public /file/** routes, which serve by unguessable
 * name alone. A name without a row (a link import's pending photo) is not.
 */
export async function isPrivatePhoto(
  q: Queryable,
  fileName: string,
): Promise<boolean> {
  const [row] = await q
    .select({ id: selfie.id })
    .from(selfie)
    .innerJoin(file, eq(file.id, selfie.photoId))
    .where(eq(file.fileName, fileName))
    .limit(1);
  return row !== undefined;
}
