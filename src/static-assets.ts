import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import type { Stats } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Config } from './config';
import type { Logger } from './logger';
import { PROJECT_ROOT } from './project-root';

// Everything served from disk lives here, the build's output included:
// bundle.css, sw.js and vendor/ are generated, and modules/ holds the client
// libraries copied out of node_modules (scripts/static-assets.ts). The
// design: src/web/shell/static-delivery.md.
export const PUBLIC_DIR = join(PROJECT_ROOT, 'public');

// The encodings the build writes next to a file (`bundle.css.br`,
// `bundle.css.gz`; scripts/static-assets.ts) and @fastify/static's
// preCompressed serves by Accept-Encoding. Any other request gets the file
// itself, which @fastify/compress compresses on the fly.
export const PRECOMPRESSED_EXTENSIONS = ['.br', '.gz'] as const;

/** The file a precompressed variant was made from, or undefined for any other path. */
export function variantSource(path: string): string | undefined {
  const ext = PRECOMPRESSED_EXTENSIONS.find((e) => path.endsWith(e));
  return ext && path.slice(0, -ext.length);
}

/**
 * A variant is current when it is at least as new as its source: the build
 * dates it just past the source it read, and any later rewrite of the source (a
 * lone `npm run generate:tailwind`, or `generate:modules` copying a library
 * update) moves the source past it.
 */
export function isFreshVariant(variant: Stats, source: Stats): boolean {
  return variant.mtimeMs >= source.mtimeMs;
}

/**
 * The variants under `root` that must not be served: older than their source,
 * or left behind by a source that is gone. Paths relative to `root`.
 */
export async function findStaleVariants(
  root: string,
): Promise<{ stale: string[]; current: number }> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const stale: string[] = [];
  let current = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const source = variantSource(path);
    if (!source) continue;
    const [variantStat, sourceStat] = await Promise.all([
      stat(path),
      stat(source).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return undefined;
        throw err;
      }),
    ]);
    if (sourceStat && isFreshVariant(variantStat, sourceStat)) {
      current += 1;
    } else {
      stale.push(relative(root, path));
    }
  }
  return { stale, current };
}

// Every static URL is versioned (`?v=` from BUILD_INFO.assetVersion in
// the layout and the importmap; `?v=<photo version>` on /file/**), so a deploy
// changes URLs, never the bytes behind one: a year, immutable. The two files
// whose URL cannot change keep revalidating: sw.js below (the browser must
// see a new worker to update the app shell) and manifest.json (a route in
// src/web/shell). NODE_ENV=development turns caching off so `tailwind
// --watch` output shows up on a plain reload.
const IMMUTABLE_YEAR = 'public, max-age=31536000, immutable';
const REVALIDATE = 'public, max-age=0';
const SERVICE_WORKER_CACHE_CONTROL = 'no-cache';

/**
 * Cache-Control for the file @fastify/static is sending. `path` is the file on
 * disk, which is `sw.js.br` when the worker goes out precompressed: the policy
 * follows the source, or the worker would be cached for a year.
 */
export function staticCacheControl(path: string, dev: boolean): string {
  const served = variantSource(path) ?? path;
  if (served.endsWith('/sw.js')) return SERVICE_WORKER_CACHE_CONTROL;
  return dev ? REVALIDATE : IMMUTABLE_YEAR;
}

/**
 * One root, public/, for every static file; /modules/* is public/modules/.
 * Keep in step with STATIC_PREFIXES in static-prefixes.ts: every path under
 * it must be one the session hook skips.
 *
 * Precompressed variants are served unless NODE_ENV=development (where
 * `tailwind --watch` rewrites bundle.css under a running server) or any
 * variant on disk is stale: a stale one would be served for a source that
 * has changed, so the boot falls back to compressing on the fly, loudly.
 */
export async function registerStaticAssets(
  app: FastifyInstance,
  config: Config,
  logger: Logger,
): Promise<void> {
  const dev = config.NODE_ENV === 'development';
  let preCompressed = false;
  if (dev) {
    logger.info('Static assets: compressed per request (development)');
  } else {
    const { stale, current } = await findStaleVariants(PUBLIC_DIR);
    if (stale.length > 0) {
      logger.warn(
        `Static assets: ${stale.length} stale precompressed file(s) (${stale.slice(0, 5).join(', ')}${stale.length > 5 ? ', ...' : ''}); compressing per request instead. Run \`npm run build\` (or \`npm run generate:precompress\`).`,
      );
    } else {
      preCompressed = true;
      logger.info(`Static assets: ${current} precompressed variant(s)`);
    }
  }

  // Per-file policy: since @fastify/static 10, setHeaders receives the
  // FastifyReply and runs after send's headers, so its Cache-Control wins.
  // (Before 10 it was the raw response and send overwrote it afterwards.)
  // preCompressed sets Content-Encoding, Content-Type (the source's) and
  // Vary: Accept-Encoding (on the identity fallback too); @fastify/compress
  // leaves a response that already has a Content-Encoding alone.
  // Never give this plugin more than one root: with preCompressed, a file
  // with no variant in the first root is looked for in the last one only
  // (@fastify/static 10.1).
  await app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    decorateReply: false,
    preCompressed,
    setHeaders: (reply, path) => {
      reply.header('Cache-Control', staticCacheControl(path, dev));
    },
  });
}
