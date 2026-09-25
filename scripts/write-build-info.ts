import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// Build step (`npm run generate:build-info`, part of `npm run build`).
// Writes public/build.json, which src/build-info.ts folds into the `?v=`
// cache key on every first-party static URL (see views/layout.hbs). The key
// must change on every deploy because /modules, /js, /assets and bundle.css
// are served immutable for a year: package.json version plus the commit when
// one can be resolved, otherwise the build timestamp still makes it unique.
const OUT_PATH = path.join(__dirname, '..', 'public', 'build.json');

function resolveCommit(): string | undefined {
  // CI and Docker builds have no .git; docker-publish can pass GIT_SHA as a
  // build-arg (see docker/Dockerfile).
  const fromEnv = process.env.GIT_SHA ?? process.env.GITHUB_SHA;
  if (fromEnv) return fromEnv.slice(0, 7);
  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
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
