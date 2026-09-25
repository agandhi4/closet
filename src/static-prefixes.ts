// Paths that never render a view and never read the session. The per-request
// hook in main.ts skips auth resolution and view-context building for them,
// so a page load's dozens of asset requests cost zero JWT verifications and
// zero user queries. Keep in step with the useStaticAssets() registrations in
// main.ts and the image routes in FileController.
export const STATIC_PREFIXES = [
  '/modules/',
  '/assets/',
  '/js/',
  '/bg-removal-models/',
  '/file/',
] as const;

export const STATIC_FILES = [
  '/bundle.css',
  '/sw.js',
  '/manifest.json',
  '/favicon.ico',
  '/robots.txt',
  '/llms.txt',
  '/llms-full.txt',
] as const;

// FileController serves immutable images under /file/**, but these two routes
// under the same prefix are guarded pages that need the auth context.
const APP_ROUTES_UNDER_STATIC_PREFIX = ['/file/files', '/file/upload'] as const;

export function isStaticPath(url: string): boolean {
  const path = url.split('?')[0];
  if ((APP_ROUTES_UNDER_STATIC_PREFIX as readonly string[]).includes(path)) {
    return false;
  }
  return (
    (STATIC_FILES as readonly string[]).includes(path) ||
    STATIC_PREFIXES.some((prefix) => path.startsWith(prefix))
  );
}
