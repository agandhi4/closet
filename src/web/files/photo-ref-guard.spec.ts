import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROJECT_ROOT } from '../../project-root';

/**
 * A signed /file URL is served without asking the database whether its
 * name is a selfie's (#162), so only a garment's photo, or a pending one
 * shown to its uploader, may ever be signed. imageUrl takes a branded
 * SignablePhotoRef (image-url.spec.ts proves a plain object does not
 * compile); these checks keep the brand's makers where they belong.
 */

const SRC = join(PROJECT_ROOT, 'src');

/** Every non-spec source file under `dir`. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.tsx?$/.test(entry.name) &&
        !/\.spec\.tsx?$/.test(entry.name),
    )
    .map((entry) => join(entry.parentPath, entry.name));
}

const read = (path: string) => readFileSync(path, 'utf8');
const name = (path: string) => relative(PROJECT_ROOT, path);

// What makes or signs a SignablePhotoRef.
const SIGNING = [
  'imageUrl',
  'SignablePhotoRef',
  'photoRefJson',
  'photoWithCutoutJson',
  'readPhotoRef',
  'pendingPhotoRef',
  'plinthPhoto',
  'PLINTH_PHOTO_COLUMNS',
  'PHOTO_REF_RELATION',
];

describe('who may sign a photo URL', () => {
  it('no outfit selfie module touches a photo-ref helper or imageUrl', () => {
    const selfies = sources(join(SRC, 'web', 'selfies'));
    expect(selfies.length).toBeGreaterThan(0);
    const found = selfies.flatMap((path) => {
      const text = read(path);
      return SIGNING.filter((word) =>
        new RegExp(`\\b${word}\\b`).test(text),
      ).map((word) => `${name(path)}: ${word}`);
    });
    expect(found).toEqual([]);
  });

  // A photo built by hand in SQL can be typed as the helpers' shape while
  // missing a field (a variant key left out signs `k=undefined`, which the
  // route answers through the row); outside a selfie's own queries, a
  // photo's JSON is photoRefJson, photoWithCutoutJson or plinthPhotoJson.
  it('builds a photo JSON only through the helpers', () => {
    const found = sources(SRC)
      .filter((path) => /'fileName',\s*\$\{file\.fileName\}/.test(read(path)))
      .map(name);
    expect(found).toEqual([
      'src/web/files/queries.ts',
      'src/web/selfies/queries.ts',
    ]);
  });

  // A positional JSON (json_build_array, decoded by readPhotoRef: the
  // gallery's and Styling's tuples) carries the variant key right after the
  // version, or its URL is signed without it.
  it('never reads a photo tuple without its variant key', () => {
    const tuple =
      /\$\{file\.fileName\},\s*\$\{file\.version\}(?!,\s*\$\{file\.variantKey\})/;
    const found = sources(SRC)
      .filter((path) => tuple.test(read(path)))
      .map(name);
    expect(found).toEqual([]);
  });

  it('only files/queries.ts asserts the brand', () => {
    // A cast (`as ... SignablePhotoRef`) or a typed sql<...SignablePhotoRef>
    // is how a plain object becomes signable.
    const assertion = /(\bas\s[^;\n]*|\bsql<[^>\n]*)\bSignablePhotoRef\b/;
    const found = sources(SRC)
      .filter((path) => assertion.test(read(path)))
      .map(name);
    expect(found).toEqual(['src/web/files/queries.ts']);
  });
});
