import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import {
  isFreshVariant,
  PRECOMPRESSED_EXTENSIONS,
  PUBLIC_DIR,
  variantSource,
} from '../src/static-assets';

// Build steps for what src/static-assets.ts serves from public/. Run by
// scripts/generate-static-assets.ts (`npm run generate:modules`,
// `npm run generate:precompress`) and, so the integration tier serves
// public/ as the build leaves it, by the integration project's globalSetup
// (test/support/static-assets-setup.ts).

const NODE_MODULES = path.join(PUBLIC_DIR, '..', 'node_modules');
export const MODULES_DIR = path.join(PUBLIC_DIR, 'modules');

/**
 * The client libraries the pages load from /modules/ (the layout's script
 * tag and importmap, src/web/layout/layout.tsx), as installed: copied into
 * public/modules/ so they are served, cached and precompressed like every
 * other static file. A library that ships no minified ES module is built
 * into public/vendor/ instead (`npm run generate:vendor`).
 */
export const CLIENT_MODULES: readonly { from: string; to: string }[] = [
  { from: 'htmx.org/dist/htmx.min.js', to: 'htmx.min.js' },
  {
    from: 'workbox-window/build/workbox-window.prod.mjs',
    to: 'workbox-window.prod.mjs',
  },
  {
    from: 'workbox-window/build/workbox-window.prod.mjs.map',
    to: 'workbox-window.prod.mjs.map',
  },
  {
    from: '@khmyznikov/pwa-install/dist/pwa-install.bundle.js',
    to: 'pwa-install.bundle.js',
  },
  {
    from: '@khmyznikov/pwa-install/dist/pwa-install.bundle.js.map',
    to: 'pwa-install.bundle.js.map',
  },
  {
    from: 'pulltorefreshjs/dist/index.esm.js',
    to: 'pulltorefresh/index.esm.js',
  },
];

/**
 * Makes public/modules/ hold exactly CLIENT_MODULES. A file whose bytes are
 * already current is left alone, so its mtime (and its precompressed
 * variants' freshness) survives a repeat run; anything else there goes.
 */
export function syncClientModules(): { copied: string[]; removed: string[] } {
  const wanted = new Set(CLIENT_MODULES.map((m) => m.to));
  const copied: string[] = [];
  for (const { from, to } of CLIENT_MODULES) {
    const source = fs.readFileSync(path.join(NODE_MODULES, from));
    const target = path.join(MODULES_DIR, to);
    if (fs.existsSync(target) && fs.readFileSync(target).equals(source)) {
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
    copied.push(to);
  }
  const removed = listFiles(MODULES_DIR)
    .map((file) => path.relative(MODULES_DIR, file))
    .filter((file) => !wanted.has(variantSource(file) ?? file));
  for (const file of removed) fs.rmSync(path.join(MODULES_DIR, file));
  return { copied, removed };
}

// Text formats worth compressing; images, fonts (woff2 is brotli already)
// and source maps (fetched only by open devtools) are not.
const COMPRESSIBLE = new Set(['.css', '.js', '.mjs', '.svg', '.txt', '.json']);
// @fastify/compress's own threshold: below it a response is sent as is.
const MIN_BYTES = 1024;

const ENCODERS: Record<
  (typeof PRECOMPRESSED_EXTENSIONS)[number],
  (data: Buffer) => Buffer
> = {
  '.br': (data) =>
    zlib.brotliCompressSync(data, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]:
          zlib.constants.BROTLI_MAX_QUALITY,
        [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
      },
    }),
  '.gz': (data) =>
    zlib.gzipSync(data, { level: zlib.constants.Z_BEST_COMPRESSION }),
};

export interface PrecompressResult {
  written: number;
  current: number;
  removed: number;
  /** Source bytes, and what brotli brought them to, over the files written. */
  bytes: number;
  brotliBytes: number;
}

/**
 * Writes a `.br` (brotli 11) and a `.gz` (gzip 9) beside every compressible
 * file of MIN_BYTES or more under `root`, and deletes every variant with no
 * eligible source. A variant already current (isFreshVariant) is kept; one
 * that would not be smaller than its source is not written. Must run after
 * every step that writes into public/.
 */
export function precompress(root: string = PUBLIC_DIR): PrecompressResult {
  const result: PrecompressResult = {
    written: 0,
    current: 0,
    removed: 0,
    bytes: 0,
    brotliBytes: 0,
  };
  const files = listFiles(root);
  const sources = files.filter(
    (file) =>
      !variantSource(file) &&
      COMPRESSIBLE.has(path.extname(file)) &&
      fs.statSync(file).size >= MIN_BYTES,
  );
  const kept = new Set<string>();
  for (const source of sources) refreshVariants(source, result, kept);
  for (const file of files) {
    if (variantSource(file) && !kept.has(file)) {
      fs.rmSync(file);
      result.removed += 1;
    }
  }
  return result;
}

/** Brings one source's variants up to date, adding them to `kept`. */
function refreshVariants(
  source: string,
  result: PrecompressResult,
  kept: Set<string>,
): void {
  const sourceStat = fs.statSync(source);
  let data: Buffer | undefined;
  for (const ext of PRECOMPRESSED_EXTENSIONS) {
    const variant = source + ext;
    const variantStat = fs.statSync(variant, { throwIfNoEntry: false });
    if (variantStat && isFreshVariant(variantStat, sourceStat)) {
      kept.add(variant);
      result.current += 1;
      continue;
    }
    data ??= fs.readFileSync(source);
    const encoded = ENCODERS[ext](data);
    if (encoded.length >= data.length) continue;
    fs.writeFileSync(variant, encoded);
    // Dated just past its source, not now: a source dated ahead of the
    // clock (copied in from elsewhere) would otherwise outdate its variant
    // for good. The extra millisecond absorbs utimes's float seconds.
    const stamp = (Math.ceil(sourceStat.mtimeMs) + 1) / 1000;
    fs.utimesSync(variant, stamp, stamp);
    kept.add(variant);
    result.written += 1;
    if (ext === '.br') {
      result.bytes += data.length;
      result.brotliBytes += encoded.length;
    }
  }
}

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}
