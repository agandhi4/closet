import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findStaleVariants,
  staticCacheControl,
  variantSource,
} from './static-assets';

describe('variantSource', () => {
  it.each([
    ['/p/bundle.css.br', '/p/bundle.css'],
    ['/p/sw.js.gz', '/p/sw.js'],
    ['/p/bundle.css', undefined],
    ['/p/icon.png', undefined],
  ])('%s -> %s', (path, source) => {
    expect(variantSource(path)).toBe(source);
  });
});

describe('staticCacheControl', () => {
  it.each(['/p/sw.js', '/p/sw.js.br', '/p/sw.js.gz'])(
    'keeps the service worker revalidating when it is %s',
    (path) => {
      expect(staticCacheControl(path, false)).toBe('no-cache');
      expect(staticCacheControl(path, true)).toBe('no-cache');
    },
  );

  it.each(['/p/bundle.css', '/p/bundle.css.br', '/p/modules/htmx.min.js.gz'])(
    'caches %s for a year, or not at all in development',
    (path) => {
      expect(staticCacheControl(path, false)).toBe(
        'public, max-age=31536000, immutable',
      );
      expect(staticCacheControl(path, true)).toBe('public, max-age=0');
    },
  );
});

describe('findStaleVariants', () => {
  let root: string;
  const at = (path: string, seconds: number) =>
    utimesSync(join(root, path), seconds, seconds);
  const put = (path: string, seconds: number) => {
    writeFileSync(join(root, path), path);
    at(path, seconds);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'closet-static-'));
    mkdirSync(join(root, 'js'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('counts variants at least as new as their source', async () => {
    put('bundle.css', 1000);
    put('bundle.css.br', 1000);
    put('js/a.js', 1000);
    put('js/a.js.gz', 2000);
    put('icon.png', 1000);
    expect(await findStaleVariants(root)).toEqual({ stale: [], current: 2 });
  });

  it('names a variant older than its source, and one whose source is gone', async () => {
    put('bundle.css', 2000);
    put('bundle.css.br', 1000);
    put('bundle.css.gz', 2000);
    put('js/gone.js.br', 1000);
    const { stale, current } = await findStaleVariants(root);
    expect(stale.sort()).toEqual(['bundle.css.br', 'js/gone.js.br']);
    expect(current).toBe(1);
  });
});
