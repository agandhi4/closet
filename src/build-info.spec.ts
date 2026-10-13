import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEV_RELEASE, loadBuildInfo } from './build-info';

describe('loadBuildInfo', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'closet-build-info-'));
    mkdirSync(join(root, 'public'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const writeBuildFile = (build: object) =>
    writeFileSync(join(root, 'public', 'build.json'), JSON.stringify(build));

  it("names the build by the image's APP_VERSION, over any build.json", () => {
    writeBuildFile({ commit: 'a'.repeat(40), builtAt: '2026-10-13T00:00:00Z' });
    expect(loadBuildInfo('sha-1234567', root)).toEqual({
      release: 'sha-1234567',
      assetVersion: 'sha-1234567',
    });
  });

  it('names a local build by the commit build.json recorded', () => {
    writeBuildFile({
      commit: '89abcdef'.repeat(5),
      builtAt: '2026-10-13T00:00:00Z',
    });
    expect(loadBuildInfo(undefined, root)).toEqual({
      release: 'sha-89abcde',
      assetVersion: 'sha-89abcde',
    });
  });

  it('keys the assets by the build time when nothing names the build', () => {
    const builtAt = '2026-10-13T00:00:00Z';
    writeBuildFile({ builtAt });
    expect(loadBuildInfo(undefined, root)).toEqual({
      release: DEV_RELEASE,
      assetVersion: `dev.${Date.parse(builtAt).toString(36)}`,
    });
    // The image built without the arg: its ARG default, `dev`.
    expect(loadBuildInfo(DEV_RELEASE, root).assetVersion).toBe(
      `dev.${Date.parse(builtAt).toString(36)}`,
    );
  });

  it('is dev with a per-boot asset key without build.json', () => {
    const info = loadBuildInfo(undefined, root);
    expect(info.release).toBe(DEV_RELEASE);
    expect(info.assetVersion).toMatch(/^dev\.[0-9a-z]+$/);
  });
});
