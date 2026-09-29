import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  concurrentlyParts,
  failureLines,
  hookSteps,
  passLine,
  tail,
  testCounts,
} from './git-hook-output';

const packageScripts = (
  JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> }
).scripts;

describe('git hook steps', () => {
  it('runs the halves of `npm run check` for pre-commit, with their parts', () => {
    expect(hookSteps(packageScripts, 'check')).toEqual([
      {
        name: 'static',
        script: 'check:static',
        parts: ['docs', 'format', 'lint', 'types'],
      },
      { name: 'tests', script: 'test:all', parts: [] },
    ]);
  });

  it('runs a script that is not a concurrently as the one step', () => {
    expect(hookSteps(packageScripts, 'verify:push')).toEqual([
      { name: 'verify:push', script: 'verify:push', parts: [] },
    ]);
  });

  it('refuses a concurrently whose parts and names disagree, or a missing entry', () => {
    expect(() =>
      concurrentlyParts('concurrently --names a "npm:x" "npm:y"'),
    ).toThrow(/--names/);
    expect(() => hookSteps({}, 'check')).toThrow(/no "check" script/);
  });
});

describe('git hook output', () => {
  it("reports Vitest's and Playwright's counts", () => {
    expect(
      testCounts(
        '\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[32m4337 passed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[33m1 skipped\x1b[39m\x1b[90m (4338)\x1b[39m\n',
      ),
    ).toBe('4337 passed, 1 skipped');
    expect(
      testCounts('Running 14 tests\n  2 skipped\n  12 passed (30.1s)\n'),
    ).toBe('2 skipped, 12 passed');
    expect(testCounts('docs:check: fine\n')).toBeUndefined();
  });

  it('prints one line for a passing step', () => {
    const step = { name: 'tests', script: 'test:all', parts: [] };
    expect(passLine(step, '      Tests  3 passed (3)\n', 97_600)).toBe(
      '✓ tests 3 passed in 98s',
    );
    const staticStep = {
      name: 'static',
      script: 'check:static',
      parts: ['docs', 'lint'],
    };
    expect(passLine(staticStep, '', 4_200)).toBe('✓ static (docs, lint) in 4s');
  });

  it("prints a failed step's last lines, without colours or trailing blanks, and its log", () => {
    const log = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join(
      '\n',
    );
    expect(tail(`${log}\n\n\n`)).toHaveLength(40);
    expect(tail(`${log}\n\n`).at(-1)).toBe('line 50');
    expect(tail('\x1b[31mAssertionError\x1b[39m')).toEqual(['AssertionError']);

    const step = { name: 'tests', script: 'test:all', parts: [] };
    const lines = failureLines(step, log, 'exit 1', 3_000, '/tmp/t.log');
    expect(lines[0]).toBe(
      '✗ tests failed, exit 1, after 3s; the end of its log:',
    );
    expect(lines[1]).toBe('  line 11');
    expect(lines.at(-1)).toBe('✗ tests: full log /tmp/t.log');
  });
});
