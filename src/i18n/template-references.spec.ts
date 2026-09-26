import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { describe, expect, it } from 'vitest';
import { PROJECT_ROOT } from '../project-root';

/**
 * Handlebars and nestjs-i18n fail soft: a missing `{{t 'lang.KEY'}}` renders
 * the raw key, and a missing partial only throws when that page renders.
 * Neither shows up anywhere but in the browser, so check every literal
 * reference statically. Keys built at runtime (month and day names,
 * CATEGORY_*) are out of scope.
 */

function filesUnder(dir: string, extensions: string[]): string[] {
  return readdirSync(join(PROJECT_ROOT, dir), {
    recursive: true,
    withFileTypes: true,
  })
    .filter(
      (entry) =>
        entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext)),
    )
    .map((entry) => join(entry.parentPath, entry.name));
}

const templates = filesUnder('views', ['.hbs']);
const sources = [
  ...templates,
  ...filesUnder('src', ['.ts']).filter(
    (file) => !file.endsWith('.spec.ts') && !file.includes('/i18n/'),
  ),
  ...filesUnder('public/js', ['.js']),
];

describe('template references', () => {
  it('every literal lang.KEY exists in the English strings', () => {
    const english = JSON.parse(
      readFileSync(join(PROJECT_ROOT, 'src/i18n/en/lang.json'), 'utf8'),
    ) as Record<string, string>;
    const missing: string[] = [];
    for (const file of sources) {
      // Comment lines may show usage examples (`{{t 'lang.KEY'}}`).
      const code = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\{\{!)/.test(line))
        .join('\n');
      for (const [, key] of code.matchAll(/['"`]lang\.([A-Za-z0-9_]+)['"`]/g)) {
        if (!(key in english)) {
          missing.push(`${relative(PROJECT_ROOT, file)}: lang.${key}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('every {{> partial}} has a file in views/partials or an inline definition', () => {
    const partialFiles = new Set(
      filesUnder('views/partials', ['.hbs']).map((file) =>
        relative(join(PROJECT_ROOT, 'views/partials'), file).replace(
          /\.hbs$/,
          '',
        ),
      ),
    );
    const missing: string[] = [];
    for (const file of templates) {
      const text = readFileSync(file, 'utf8');
      const inline = new Set(
        [...text.matchAll(/\{\{#\*inline\s+"([^"]+)"/g)].map(
          ([, name]) => name,
        ),
      );
      for (const [, name] of text.matchAll(/\{\{>\s*([\w/-]+)/g)) {
        if (!partialFiles.has(name) && !inline.has(name)) {
          missing.push(`${relative(PROJECT_ROOT, file)}: ${name}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
