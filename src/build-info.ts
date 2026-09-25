import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { PROJECT_ROOT } from './project-root';

export interface BuildInfo {
  /** package.json version, shown on /about. */
  version: string;
  /** Short commit from public/build.json when the build could resolve one. */
  commit?: string;
  /**
   * Cache key appended as `?v=` to every first-party static URL (layout.hbs,
   * importmap, show.hbs). Static roots in app.ts are served immutable for a
   * year, so this must differ between any two deploys: version plus commit
   * (or build time) from public/build.json, which scripts/write-build-info.ts
   * writes during `npm run build`. Without build.json (start:dev, jest) the
   * key is unique per boot instead.
   */
  assetVersion: string;
}

interface BuildFile {
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
  const stamp =
    build.commit ??
    (build.builtAt ? Date.parse(build.builtAt).toString(36) : 'unknown');
  return {
    version,
    commit: build.commit,
    assetVersion: `${version}+${stamp}`,
  };
}

// Read once at boot; consumed by ViewContextService (template context) and
// logged by createApp().
export const BUILD_INFO: BuildInfo = loadBuildInfo();
