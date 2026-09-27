import { ImageVariant } from './image-variant';

export interface ImageRef {
  fileName: string;
  version?: number;
}

// The single source of truth for photo paths (/file/** and /selfies/*), for
// JSX views and view-models that pre-build URLs. The routes are in
// routes.ts beside this file and src/web/selfies/routes.ts, and must stay
// in step.
//
// `v` is the File.version cache-buster: every variant is served with an
// immutable one-year Cache-Control, so a rewritten image is only ever seen
// through a new version number.
export function imageUrl(image: ImageRef, variant: ImageVariant): string {
  return variantPath('/file', image, variant);
}

/**
 * An outfit selfie's URL (#19): served only to its owner by
 * src/web/selfies/routes.ts, never under the public /file/** (which
 * refuses selfie names). A selfie keeps its background, so it has no nobg.
 */
export function selfieUrl(
  image: ImageRef,
  variant: Exclude<ImageVariant, 'nobg'>,
): string {
  return variantPath('/selfies', image, variant);
}

function variantPath(
  root: string,
  image: ImageRef,
  variant: ImageVariant,
): string {
  const version = image.version ?? 1;
  const prefix = variant === 'original' ? root : `${root}/${variant}`;
  return `${prefix}/${encodeURIComponent(image.fileName)}?v=${version}`;
}
