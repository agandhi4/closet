import { randomBytes } from 'node:crypto';

// Every stored photo is a set of WebP files sharing one base name:
//   original  <uuid>.webp                the upload, 1080px inside, q90
//   nobg      <uuid>-nobg[-<key>].webp   background-removed cutout, same size, q90
//   thumb     <uuid>-thumb[-<key>].webp  400px inside, q80, derived from nobg if present
// Only the original has a `file` row; the others are derived on disk and
// addressed through variantFileName. The original never changes. A cutout
// written onto an existing row (Photos.writeCutout: a mask edit, a server
// job) is stored as a nobg and thumb under a fresh variant key before the
// row's transaction, which then points `file.variant_key` at them; bytes
// written before their row exists (an upload, a copy, the seed) have none.
// Used by Photos, the /file routes, reconciliation and imageUrl().
export const IMAGE_VARIANTS = ['original', 'nobg', 'thumb'] as const;

export type ImageVariant = (typeof IMAGE_VARIANTS)[number];

export function isImageVariant(value: string): value is ImageVariant {
  return (IMAGE_VARIANTS as readonly string[]).includes(value);
}

/**
 * A photo's files as its row names them: the base name and `file.variant_key`
 * (null while the nobg and thumb are the ones written with the photo, and
 * for bytes that have no row: a pending photo, an upload not yet committed).
 * Serving and deleting a photo's variants need both; select them with
 * STORED_PHOTO_COLUMNS (queries.ts).
 */
export interface StoredPhoto {
  fileName: string;
  variantKey: string | null;
}

/**
 * A photo that cannot have a variant key: bytes stored before their `file`
 * row exists (an upload before its commit, a pending photo, a copy), and an
 * outfit selfie (unwanted: file_variant_key_check allows a key only on a
 * ready or edited row). Anything else selects STORED_PHOTO_COLUMNS.
 */
export function unkeyedPhoto(fileName: string): StoredPhoto {
  return { fileName, variantKey: null };
}

/** 12 hex digits: the shape the file_variant_key_check constraint and parseStoredName accept. */
export function newVariantKey(): string {
  return randomBytes(6).toString('hex');
}

export function variantFileName(
  fileName: string,
  variant: ImageVariant,
  variantKey: string | null = null,
): string {
  if (variant === 'original') return fileName;
  const extIndex = fileName.lastIndexOf('.');
  const suffix = variantKey ? `-${variant}-${variantKey}` : `-${variant}`;
  return extIndex === -1
    ? `${fileName}${suffix}`
    : `${fileName.slice(0, extIndex)}${suffix}${fileName.slice(extIndex)}`;
}

// Stored names are `<uuid>.webp` plus the two derived suffixes, each with an
// optional variant key (see above). Anything else under DATA_PATH (app.log)
// is not a photo: the /file routes never serve it and reconciliation never
// touches it.
const STORED_NAME =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-(nobg|thumb)(?:-([0-9a-f]{12}))?)?\.webp$/i;

export interface ParsedStoredName {
  /** The original's file name, the key of the File row. */
  baseName: string;
  variant: ImageVariant;
  /** A nobg's or thumb's variant key; null for the original and unkeyed variants. */
  variantKey: string | null;
}

/** The one definition of a stored photo name: the /file routes and reconciliation. */
export function parseStoredName(name: string): ParsedStoredName | undefined {
  const match = STORED_NAME.exec(name);
  if (!match) return undefined;
  const [, uuid, suffix, key] = match;
  return {
    baseName: `${uuid}.webp`,
    variant: (suffix as ImageVariant | undefined) ?? 'original',
    variantKey: key ?? null,
  };
}
