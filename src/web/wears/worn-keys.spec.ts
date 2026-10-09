import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import english from '../../i18n/en/lang.json';
import { PROJECT_ROOT } from '../../project-root';

/** Every catalog key, dotted (`wear.WORE_IT`). */
function keysOf(node: object, prefix = ''): string[] {
  return Object.entries(node).flatMap(([key, value]) =>
    typeof value === 'string'
      ? [prefix + key]
      : keysOf(value as object, `${prefix}${key}.`),
  );
}

/** The app's own source (specs left out: a key only a spec names is unused). */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.spec\.tsx?$/.test(entry.name)
      ? [readFileSync(path, 'utf8')]
      : [];
  });
}

// #359 left one key family for marking an outfit worn (WornControl's
// `wear.*`); the calendar's, Today's and the trip's copies drifted into dead
// keys before (CALENDAR_WORN_RECENTLY, CALENDAR_MARK_WORN, ...).
describe('the worn strings', () => {
  it('leaves no *WORN* or *WORE* key that no source names', () => {
    const source = sources(join(PROJECT_ROOT, 'src')).join('\n');
    const unused = keysOf(english)
      .filter((key) => /WORN|WORE/.test(key.split('.').at(-1)!))
      .filter((key) => !source.includes(`'${key}'`));
    expect(unused).toEqual([]);
  });
});
