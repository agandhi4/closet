import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { PROJECT_ROOT } from './project-root';

export interface BuildInfo {
  /** package.json version, shown on /about. */
  version: string;
  /** Short commit (7 characters) from public/build.json: the boot log and the cache key. */
  commit?: string;
  /**
   * The full commit sha from public/build.json: the error tracker's release
   * (src/metrics/error-tracker.ts), on the server's events and the pages'
   * (the layout hands it to public/js/errors.js). In the image it is CI's
   * GIT_SHA build-arg (docker/Dockerfile).
   */
  sha?: string;
  /**
   * Cache key appended as `?v=` to every first-party static URL (the
   * layouts, the importmap, page modules). Static roots in app.ts are served immutable for a
   * year, so this must differ between any two deploys: version plus commit
   * (or build time) from public/build.json, which scripts/write-build-info.ts
   * writes during `npm run build`. Without build.json (start:dev, tests) the
   * key is unique per boot instead.
   */
  assetVersion: string;
}

interface BuildFile {
  /** The full sha (7 characters in builds before #117). */
  commit?: string;
  builtAt?: string;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export function loadBuildInfo(root = PROJECT_ROOT): BuildInfo {
  const { version } = readJson<{ version: string }>(join(root, 'package.json'));
  const buildFile = join(root, 'public', 'build.json');
  if (!existsSync(buildFile)) {
    return {
      version,
      assetVersion: `${version}-dev.${Date.now().toString(36)}`,
    };
  }
  const build = readJson<BuildFile>(buildFile);
  const commit = build.commit?.slice(0, 7);
  const stamp =
    commit ??
    (build.builtAt ? Date.parse(build.builtAt).toString(36) : 'unknown');
  return {
    version,
    commit,
    sha: build.commit,
    assetVersion: `${version}+${stamp}`,
  };
}

// Read once at boot; consumed by the page context (src/web/view-context.ts)
// and the error tracker's release, and logged by createApp().
export const BUILD_INFO: BuildInfo = loadBuildInfo();
