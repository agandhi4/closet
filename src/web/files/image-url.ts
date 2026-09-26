import { ImageVariant } from './image-variant';

export interface ImageRef {
  fileName: string;
  version?: number;
}

// The single source of truth for /file/** photo paths, for JSX views and
// view-models that pre-build URLs. The routes are in routes.ts beside this file and must stay in step.
//
// `v` is the File.version cache-buster: every variant is served with an
// immutable one-year Cache-Control, so a rewritten image is only ever seen
// through a new version number.
export function imageUrl(image: ImageRef, variant: ImageVariant): string {
  const version = image.version ?? 1;
  const prefix = variant === 'original' ? '/file' : `/file/${variant}`;
  return `${prefix}/${encodeURIComponent(image.fileName)}?v=${version}`;
}
