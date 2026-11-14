import fs from 'fs';
import path from 'path';
import {
  injectManifest,
  type InjectManifestOptions,
  type ManifestEntry,
} from 'workbox-build';
import { PUBLIC_DIR } from '../src/static-assets';
import { staticBuildId } from '../src/static-build';
import { CLIENT_MODULES } from './static-assets';

// `npm run generate:sw`, after esbuild bundled views/assets/src-sw.ts into src-sw.js: injects the
// precache manifest into public/sw.js and records the static set's id (staticBuildId) in
// public/build.json, computed from the very entries injected. The worker computes the same id
// from its injected manifest and names its precache by it; src/build-info.ts makes it the pages'
// `?v=` (production only), so a page's `?v=` names the precache holding exactly its bytes (#656,
// src/web/shell/updates.md). Both files are written by this one step, so they never disagree.

const BUILD_FILE = path.join(PUBLIC_DIR, 'build.json');

const config: InjectManifestOptions = {
  globDirectory: 'public/',
  // The precache is a build's whole versioned set: every file a page of it can name with `?v=`
  // (the layout, its importmap, a page's module import) is in it, so an older build's page
  // offline meets its own build's bytes, whatever it imports (#656). woff2: the two webfonts
  // (views/assets/fonts.css), about 84 KB together, so an installed app never draws a page in
  // the fallback font. mjs: workbox-window.
  globPatterns: ['**/*.{png,webp,css,ico,js,mjs,json,txt,woff2}'],
  globIgnores: [
    // No page renders anything under assets/: the app icon (45 KB) is read by the OS when the
    // app is installed, by link previews and by the install dialog, all online, so precaching
    // it cost every fresh install for nothing (issue #4).
    'assets/**',
    // Neither the LLM corpus files nor the build stamp belong in the app shell.
    'llms*.txt',
    'robots.txt',
    'build.json',
    // The fonts' @font-face rules, already inlined into bundle.css.
    'vendor/fonts/fonts.css',
  ],
  swDest: 'public/sw.js',
  swSrc: 'views/assets/src-sw.js',
};

// What the layout names under /modules/ and the opt-in error beacon (SENTRY_DSN): a file a page
// can name that the precache lacks is one an older page would load from the network, and offline
// not at all. The globs must keep them.
const MUST_PRECACHE = [
  ...CLIENT_MODULES.map((module) => `modules/${module.to}`).filter(
    (url) => !url.endsWith('.map'),
  ),
  'js/errors.js',
];

async function main(): Promise<void> {
  let injected: readonly ManifestEntry[] = [];
  const { count, size, warnings } = await injectManifest({
    ...config,
    manifestTransforms: [
      (entries) => {
        injected = entries;
        return { manifest: entries, warnings: [] };
      },
    ],
  });
  for (const warning of warnings) console.warn(`workbox: ${warning}`);
  const urls = new Set(injected.map((entry) => entry.url));
  const missing = MUST_PRECACHE.filter((url) => !urls.has(url));
  if (missing.length > 0) {
    throw new Error(`not precached: ${missing.join(', ')}`);
  }
  const staticId = staticBuildId(injected);
  const build: Record<string, unknown> = fs.existsSync(BUILD_FILE)
    ? (JSON.parse(fs.readFileSync(BUILD_FILE, 'utf8')) as Record<
        string,
        unknown
      >)
    : {};
  fs.writeFileSync(
    BUILD_FILE,
    JSON.stringify({ ...build, staticId }, null, 2) + '\n',
  );
  console.log(
    `public/sw.js: ${count} precached file(s), ${(size / 1024).toFixed(1)} KB, static id ${staticId}`,
  );
}

main().catch((error: unknown) => {
  console.error('generate:sw failed', error);
  process.exit(1);
});
