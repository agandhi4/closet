// Paths that never render a view and never read the session. The per-request
// hook in app.ts skips auth resolution and view-context building for them,
// so a page load's dozens of asset requests cost zero JWT verifications and
// zero user queries. Keep in step with the useStaticAssets() registrations in
// app.ts and the image routes in FileController.
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
  // Connectivity heartbeat (public/js/connectivity.js): a probe must never
  // cost a JWT verification or a user query.
  '/healthz',
  '/favicon.ico',
  '/robots.txt',
  '/llms.txt',
  '/llms-full.txt',
] as const;

// Every /file/** route is an image variant served by FileController without
// a session; a new page under that prefix would need its own carve-out here.
export function isStaticPath(url: string): boolean {
  const path = url.split('?')[0];
  return (
    (STATIC_FILES as readonly string[]).includes(path) ||
    STATIC_PREFIXES.some((prefix) => path.startsWith(prefix))
  );
}
