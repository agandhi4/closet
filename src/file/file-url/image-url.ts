import { ImageVariant } from '../image-variant';

export interface ImageRef {
  fileName: string;
  version?: number;
}

// The single source of truth for /file/** image paths. Used by the `imageUrl`
// Handlebars helper (src/app.ts), view-models that pre-build URLs, and
// FileUrlService. Routes live in FileController and must stay in step.
//
// `v` is the File.version cache-buster: every variant is served with an
// immutable one-year Cache-Control, so a rewritten image is only ever seen
// through a new version number.
export function imageUrl(image: ImageRef, variant: ImageVariant): string {
  const version = image.version ?? 1;
  const prefix = variant === 'original' ? '/file' : `/file/${variant}`;
  return `${prefix}/${encodeURIComponent(image.fileName)}?v=${version}`;
}
