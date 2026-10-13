import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { PROJECT_ROOT } from './project-root';

/**
 * The running build's identity, resolved once by createApp() from
 * config.APP_VERSION. One version string names a build everywhere (owner
 * rule 2026-10-13, docs/decisions.md): the image's APP_VERSION, baked in by
 * its build (`sha-<7>` from ci.yml's publish job, `gate-<n>` from the PR
 * gate, `dev` when built without the arg).
 */
export interface BuildInfo {
  /**
   * /healthz's `version`, /about, the MCP server's version, the boot log, and
   * the error tracker's release on the server's events and the pages' (the
   * layout hands it to public/js/errors.js). Outside an image: `sha-<7>` of
   * the commit a local `npm run build` recorded in public/build.json, else
   * `dev` (start:dev, the tests).
   */
  release: string;
  /**
   * Cache key appended as `?v=` to every first-party static URL (the
   * layouts, the importmap, page modules). Static roots in app.ts are served
   * immutable for a year, so this must differ between any two deploys: the
   * release when it names a build, else the build time public/build.json
   * records (an image built without APP_VERSION), else unique per boot.
   */
  assetVersion: string;
}

/** The release of a build nothing names. */
export const DEV_RELEASE = 'dev';

interface BuildFile {
  /** The full sha, when the build had a .git (never inside the image). */
  commit?: string;
  builtAt?: string;
}

/**
 * Used by: createApp() (src/app.ts) and the page audit's fixture. Pure apart
 * from reading public/build.json, which scripts/write-build-info.ts writes
 * during `npm run build`.
 */
export function loadBuildInfo(
  appVersion: string | undefined,
  root = PROJECT_ROOT,
): BuildInfo {
  const buildFile = join(root, 'public', 'build.json');
  const build: BuildFile = existsSync(buildFile)
    ? (JSON.parse(readFileSync(buildFile, 'utf8')) as BuildFile)
    : {};
  const release =
    appVersion ??
    (build.commit ? `sha-${build.commit.slice(0, 7)}` : DEV_RELEASE);
  let assetVersion = release;
  if (release === DEV_RELEASE) {
    const builtAt = build.builtAt ? Date.parse(build.builtAt) : Date.now();
    assetVersion = `${DEV_RELEASE}.${builtAt.toString(36)}`;
  }
  return { release, assetVersion };
}
