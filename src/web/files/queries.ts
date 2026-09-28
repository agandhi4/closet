import { eq, sql } from 'drizzle-orm';
import { CUTOUT_QUEUED_NOTIFY } from '../../cutout/queries';
import {
  type CutoutStatus,
  type InitialCutoutColumns,
  showsCutout,
} from '../../cutout/state';
import type { Db, Queryable } from '../../db/client';
import { file, garment } from '../../db/schema';
import { unkeyedPhoto } from './image-variant';
import type {
  PhotoRefFields,
  PlinthPhoto,
  SignablePhotoRef,
} from './image-url';

/*
 * The photo-ref helpers: the only makers of a SignablePhotoRef, the one
 * type imageUrl signs (#162). Each reads a garment's `file` row (a wardrobe,
 * wishlist or outfit photo) or names a pending photo; an outfit selfie's
 * queries (src/web/selfies) never import them (photo-ref-guard.spec.ts).
 * A signed URL is served without asking the database whether the name is a
 * selfie's, so a new caller that could pass a selfie's row here would serve
 * it to anyone holding the URL.
 */

/**
 * A left-joined `file` row as imageUrl's photo, selected as the row's
 * `photo` or built into a json_agg/json_build_object: the name, the
 * version and the variant key its URL signs; null when the join found no
 * row (a garment without a photo).
 */
export const photoRefJson = sql<SignablePhotoRef | null>`case when ${file.id} is null then null else json_build_object('fileName', ${file.fileName}, 'version', ${file.version}, 'variantKey', ${file.variantKey}) end`;

/** A garment's photo with its cutout state (its page, the export). */
export type PhotoWithCutout = SignablePhotoRef & {
  version: number;
  cutoutStatus: CutoutStatus;
};

/** photoRefJson with the cutout state. */
export const photoWithCutoutJson = sql<PhotoWithCutout | null>`case when ${file.id} is null then null else json_build_object('fileName', ${file.fileName}, 'version', ${file.version}, 'variantKey', ${file.variantKey}, 'cutoutStatus', ${file.cutoutStatus}) end`;

/**
 * The decoder for a garment photo read some other way: a relational
 * query's `with: { photo: PHOTO_REF_RELATION }`, a JSON array's fields.
 * Its extra fields (a share id) ride along.
 */
export function readPhotoRef<T extends PhotoRefFields>(
  photo: T,
): T & SignablePhotoRef;
export function readPhotoRef<T extends PhotoRefFields>(
  photo: T | null,
): (T & SignablePhotoRef) | null;
export function readPhotoRef<T extends PhotoRefFields>(
  photo: T | null,
): (T & SignablePhotoRef) | null {
  return photo as (T & SignablePhotoRef) | null;
}

/** A relational query's garment `photo` columns, for readPhotoRef. */
export const PHOTO_REF_RELATION = {
  columns: { fileName: true, version: true, variantKey: true },
} as const;

/** A pending photo's thumb, shown to the user who stored it (no row yet). */
export function pendingPhotoRef(fileName: string): SignablePhotoRef {
  return unkeyedPhoto(fileName) as SignablePhotoRef;
}

/**
 * A left-joined `file` row's columns for a photo the plinth draws (the
 * wardrobe grid's tiles, the capsule strips): select them as the row's
 * `photo`, then map it through plinthPhoto.
 */
export const PLINTH_PHOTO_COLUMNS = {
  fileName: file.fileName,
  version: file.version,
  variantKey: file.variantKey,
  cutoutStatus: file.cutoutStatus,
};

/**
 * PLINTH_PHOTO_COLUMNS as a JSON object inside a json_agg (the capsule
 * list's strips), for plinthPhoto; null when the join found no `file` row.
 * Every field plinthPhoto reads is here: a JSON missing the variant key
 * would sign `k=undefined`.
 */
export const plinthPhotoJson = sql<
  Parameters<typeof plinthPhoto>[0]
>`case when ${file.id} is null then null else json_build_object('fileName', ${file.fileName}, 'version', ${file.version}, 'variantKey', ${file.variantKey}, 'cutoutStatus', ${file.cutoutStatus}) end`;

export function plinthPhoto(
  photo: {
    fileName: string;
    version: number;
    variantKey: string | null;
    cutoutStatus: CutoutStatus;
  } | null,
): PlinthPhoto | null {
  if (!photo) return null;
  const { cutoutStatus, ...ref } = photo;
  return {
    ...(ref as SignablePhotoRef),
    cutout: showsCutout(cutoutStatus),
  };
}

/**
 * A `file` row's StoredPhoto (image-variant.ts): what serving or deleting
 * its bytes needs. Every query that hands a photo to Photos.getVariant,
 * copy or deleteVariants selects these.
 */
export const STORED_PHOTO_COLUMNS = {
  fileName: file.fileName,
  variantKey: file.variantKey,
};

/** The row's variant key; undefined when no row has that name. */
export async function findVariantKey(
  q: Queryable,
  fileName: string,
): Promise<string | null | undefined> {
  const [row] = await q
    .select({ variantKey: file.variantKey })
    .from(file)
    .where(eq(file.fileName, fileName));
  return row?.variantKey;
}

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
 * cutout columns (initialCutoutState) default to `none`; a pending row
 * notifies the cutout queues on commit, whichever process inserts it.
 */
export async function insertPhotoRow(
  q: Queryable,
  row: NewPhotoRow & Partial<InitialCutoutColumns>,
): Promise<number> {
  const [inserted] = await q
    .insert(file)
    .values(row)
    .returning({
      id: file.id,
      ...(row.cutoutStatus === 'pending' && { notified: CUTOUT_QUEUED_NOTIFY }),
    });
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

/**
 * The stored name behind a share link's image (the watermark route): a
 * garment's photo, the only kind a share page shows. Any other row (an
 * outfit selfie, #19, whose share id is never rendered) is not found.
 */
export async function findPhotoByShareableId(
  db: Db,
  shareableId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ fileName: file.fileName })
    .from(file)
    .innerJoin(garment, eq(garment.photoId, file.id))
    .where(eq(file.shareableId, shareableId))
    .limit(1);
  return row?.fileName;
}
