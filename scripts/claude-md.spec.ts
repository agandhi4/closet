import { describe, expect, it } from 'vitest';
import { AREA_BUDGET, areaIndex, claudeMdProblems } from './claude-md';

const root = (index: string, elsewhere = '') =>
  [
    '# Closet',
    '',
    '## Architecture',
    '',
    elsewhere,
    '',
    '### Area index',
    '',
    '| Area | Doc |',
    '| --- | --- |',
    index,
    '',
    '### Routes',
    '',
    'Nothing here.',
  ].join('\n');

const onDisk = () => true;

describe('docs:check', () => {
  it('reads the Area index section alone', () => {
    const text = root(
      '| Seed | `src/seed/CLAUDE.md` |',
      'see `test/CLAUDE.md`',
    );
    expect(areaIndex(text)).toContain('src/seed/CLAUDE.md');
    expect(areaIndex(text)).not.toContain('test/CLAUDE.md');
    expect(areaIndex(text)).not.toContain('Nothing here');
    expect(areaIndex('# Closet\n')).toBeUndefined();
  });

  it('passes a doc in the index', () => {
    expect(
      claudeMdProblems(
        root('| Seed | `src/seed/CLAUDE.md` |'),
        [{ doc: 'src/seed/CLAUDE.md', size: 100 }],
        onDisk,
      ),
    ).toEqual([]);
  });

  it('refuses a doc named only outside the index (#119)', () => {
    expect(
      claudeMdProblems(
        root('', 'Layout: seed/ is in `src/seed/CLAUDE.md`'),
        [{ doc: 'src/seed/CLAUDE.md', size: 100 }],
        onDisk,
      ),
    ).toEqual(["src/seed/CLAUDE.md is not in CLAUDE.md's area index"]);
  });

  it('refuses a root without an index, an oversized area and a stale name', () => {
    expect(
      claudeMdProblems(
        '# Closet\n\nsee `src/gone/CLAUDE.md`\n',
        [{ doc: 'src/seed/CLAUDE.md', size: AREA_BUDGET + 1 }],
        (doc) => doc !== 'src/gone/CLAUDE.md',
      ),
    ).toEqual([
      'CLAUDE.md has no "### Area index" section',
      "src/seed/CLAUDE.md is 16.0 KB, over the 16.0 KB area budget: split it (a subdirectory's CLAUDE.md or a sibling doc it links)",
      'CLAUDE.md names src/gone/CLAUDE.md, which does not exist',
    ]);
  });
});
