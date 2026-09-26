// Every stored photo is a set of WebP files sharing one base name:
//   original  <uuid>.webp        the upload, 1080px inside, q90
//   nobg      <uuid>-nobg.webp   background-removed cutout, same size, q90
//   thumb     <uuid>-thumb.webp  400px inside, q80, derived from nobg if present
// Only the original has a `file` row; the others are derived on disk and
// addressed through variantFileName. Used by Photos, the /file routes,
// reconciliation and imageUrl().
export const IMAGE_VARIANTS = ['original', 'nobg', 'thumb'] as const;

export type ImageVariant = (typeof IMAGE_VARIANTS)[number];

export function isImageVariant(value: string): value is ImageVariant {
  return (IMAGE_VARIANTS as readonly string[]).includes(value);
}

export function variantFileName(
  fileName: string,
  variant: ImageVariant,
): string {
  if (variant === 'original') return fileName;
  const extIndex = fileName.lastIndexOf('.');
  const suffix = `-${variant}`;
  return extIndex === -1
    ? `${fileName}${suffix}`
    : `${fileName.slice(0, extIndex)}${suffix}${fileName.slice(extIndex)}`;
}

// Stored names are `<uuid>.webp` plus the two derived suffixes (see
// Photos.storeUpload). Anything else under DATA_PATH (app.log) is not a
// photo: the /file routes never serve it and reconciliation never touches it.
const STORED_NAME =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-(nobg|thumb))?\.webp$/i;

export interface ParsedStoredName {
  /** The original's file name, the key of the File row. */
  baseName: string;
  variant: ImageVariant;
}

/** The one definition of a stored photo name: the /file routes and reconciliation. */
export function parseStoredName(name: string): ParsedStoredName | undefined {
  const match = STORED_NAME.exec(name);
  if (!match) return undefined;
  const [, uuid, suffix] = match;
  return {
    baseName: `${uuid}.webp`,
    variant: (suffix as ImageVariant | undefined) ?? 'original',
  };
}
