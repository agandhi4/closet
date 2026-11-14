import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { PROJECT_ROOT } from './project-root';

/**
 * The running build's identity, resolved once by createApp() from
 * config.APP_VERSION. One version string names a build everywhere (owner
 * rule 2026-10-13, docs/decisions.md): the image's APP_VERSION, baked in by
 * its build (the bare 7-char sha from ci.yml's publish job, `gate-<n>` from the PR
 * gate, `dev` when built without the arg).
 */
export interface BuildInfo {
  /**
   * /health/ready's `version`, /about, the MCP server's version, the boot log, and
   * the error tracker's release on the server's events and the pages' (the
   * layout hands it to public/js/errors.js). Outside an image: the 7-char sha of
   * the commit a local `npm run build` recorded in public/build.json, else
   * `dev` (start:dev, the tests).
   */
  release: string;
  /**
   * Cache key appended as `?v=` to every first-party static URL (the
   * layouts, the importmap, page modules). Static roots in app.ts are served
   * immutable for a year, so it must change whenever their bytes do. In
   * production it is the static set's content id (`staticId`, src/static-build.ts),
   * which scripts/generate-sw.ts writes into public/build.json beside the
   * sw.js it builds: the name of the worker's precache holding exactly those
   * bytes, unchanged by a deploy that changed only server code (#656,
   * docs/decisions.md 2026-11-13). Elsewhere, and in a build without one: the
   * release when it names a build, else the build time public/build.json
   * records, else unique per boot.
   */
  assetVersion: string;
}

/** The release of a build nothing names. */
export const DEV_RELEASE = 'dev';

interface BuildFile {
  /** The full sha, when the build had a .git (never inside the image). */
  commit?: string;
  builtAt?: string;
  /** The static set's content id, written with sw.js by scripts/generate-sw.ts. */
  staticId?: string;
}

export interface BuildInfoOptions {
  /**
   * Whether build.json's `staticId` keys the static URLs: production only
   * (the image, start:prod, start:test under Playwright, the page audit).
   * `start:dev` rebuilds files under it (tailwind --watch) and the
   * integration tier has no worker and pins its key to APP_VERSION, so a
   * build.json an earlier `npm run build` left behind never names their
   * static set.
   */
  trustStaticId?: boolean;
  root?: string;
}

/**
 * Used by: createApp() (src/app.ts) and the page audit's fixture. Pure apart
 * from reading public/build.json, which scripts/write-build-info.ts writes
 * during `npm run build` and scripts/generate-sw.ts adds `staticId` to.
 */
export function loadBuildInfo(
  appVersion: string | undefined,
  { trustStaticId = false, root = PROJECT_ROOT }: BuildInfoOptions = {},
): BuildInfo {
  const build = readBuildFile(root);
  const release =
    appVersion ?? (build.commit ? build.commit.slice(0, 7) : DEV_RELEASE);
  if (trustStaticId && build.staticId) {
    return { release, assetVersion: build.staticId };
  }
  return { release, assetVersion: releaseAssetKey(release, build) };
}

function readBuildFile(root: string): BuildFile {
  const buildFile = join(root, 'public', 'build.json');
  return existsSync(buildFile)
    ? (JSON.parse(readFileSync(buildFile, 'utf8')) as BuildFile)
    : {};
}

/** The key without a trusted static id: the release, or the build time of a build nothing names. */
function releaseAssetKey(release: string, build: BuildFile): string {
  if (release !== DEV_RELEASE) return release;
  const builtAt = build.builtAt ? Date.parse(build.builtAt) : Date.now();
  return `${DEV_RELEASE}.${builtAt.toString(36)}`;
}
