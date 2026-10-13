import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// Build step (`npm run generate:build-info`, part of `npm run build`).
// Writes public/build.json, which src/build-info.ts reads only when nothing
// else names the build: inside the image APP_VERSION does (Dockerfile), and
// the image build has no .git, so there this records just the build time
// (the asset cache key of an image built without APP_VERSION). A local
// build records the commit, which names its release `sha-<7>`.
const OUT_PATH = path.join(__dirname, '..', 'public', 'build.json');

function resolveCommit(): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

const info = {
  commit: resolveCommit(),
  builtAt: new Date().toISOString(),
};
fs.writeFileSync(OUT_PATH, JSON.stringify(info, null, 2) + '\n');
console.log(
  `Wrote ${path.relative(process.cwd(), OUT_PATH)} (${info.commit ?? 'no commit'}, ${info.builtAt})`,
);
