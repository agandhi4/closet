import { eq, type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Queryable } from '../../db/client';
import { file, garment, selfie } from '../../db/schema';
import type { StoredPhoto } from './image-variant';

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
 * The stored name as anything that serves photos by name alone serves it
 * (the public /file/** routes, the MCP photo tool): its StoredPhoto, whose
 * variant key names the nobg and thumb its row points at (none for a name
 * without a row: a link import's pending photo), or undefined when only its
 * owner may see it: an outfit selfie, served by the session-checked GET
 * /selfies/* (src/web/selfies). A new kind of private photo joins the
 * refusal here. One statement per image request.
 */
export async function publicPhoto(
  q: Queryable,
  fileName: string,
): Promise<StoredPhoto | undefined> {
  const [row] = await q
    .select({ variantKey: file.variantKey, selfieId: selfie.id })
    .from(file)
    .leftJoin(selfie, eq(selfie.photoId, file.id))
    .where(eq(file.fileName, fileName))
    .limit(1);
  if (row?.selfieId != null) return undefined;
  return { fileName, variantKey: row?.variantKey ?? null };
}
