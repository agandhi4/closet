// Every stored photo is a set of WebP files sharing one base name:
//   original  <uuid>.webp        the upload, 1080px inside, q90
//   nobg      <uuid>-nobg.webp   background-removed cutout, same size, q90
//   thumb     <uuid>-thumb.webp  400px inside, q80, derived from nobg if present
// Only the original has a File row; the others are derived on disk and
// addressed through variantFileName. Used by FileService, FileController and
// the imageUrl template helper.
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
