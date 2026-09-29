// The pure half of scripts/git-hook.ts (the runner behind .githooks/): which steps a hook
// runs, and what it prints of each step's log. Pure so scripts/git-hook-output.spec.ts can
// prove it; docs/git-hooks.md has the why (#260).

/** One `npm run -s <script>` the hook runs, with its output going to a log file. */
export interface HookStep {
  name: string;
  script: string;
  /** The names of its own parallel parts, when the script is itself a `concurrently`. */
  parts: string[];
}

/** Lines of a failed step's log the hook prints: the failing test or error sits at the end. */
export const FAILURE_TAIL_LINES = 40;

// concurrently's own flags in package.json: `--names a,b` and one "npm:<script>" per part.
const NAMES_FLAG = /--names\s+(\S+)/;
const NPM_PART = /"npm:([^"]+)"/g;

/**
 * The parts of a `concurrently --names a,b "npm:x" "npm:y"` script, or undefined when the
 * script is not one. The hook reads its steps from package.json this way so `npm run check`
 * stays their one definition: a part added there is a step the hook runs, with no second list.
 */
export function concurrentlyParts(
  command: string,
): { name: string; script: string }[] | undefined {
  if (!command.startsWith('concurrently ')) return undefined;
  const names = NAMES_FLAG.exec(command)?.[1].split(',') ?? [];
  const scripts = [...command.matchAll(NPM_PART)].map((match) => match[1]);
  if (scripts.length === 0 || names.length !== scripts.length)
    throw new Error(
      `cannot read the parts of "${command}": each "npm:<script>" needs a --names entry`,
    );
  return scripts.map((script, i) => ({ name: names[i], script }));
}

/**
 * The steps a hook runs for its package.json entry script: that script's own parallel parts
 * when it is a `concurrently` (`check` is static and tests), else the script alone
 * (`verify:push`). Each step lists its parts in turn (static's docs, format, lint, types).
 */
export function hookSteps(
  scripts: Record<string, string>,
  entry: string,
): HookStep[] {
  const command = scripts[entry];
  if (command === undefined)
    throw new Error(`package.json has no "${entry}" script`);
  const parts = concurrentlyParts(command) ?? [{ name: entry, script: entry }];
  return parts.map(({ name, script }) => ({
    name,
    script,
    parts: (concurrentlyParts(scripts[script] ?? '') ?? []).map((p) => p.name),
  }));
}

// eslint-disable-next-line no-control-regex -- SGR escapes are control characters
const ANSI = /\x1b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** The last `count` lines of a log, trailing blank lines dropped. */
export function tail(log: string, count = FAILURE_TAIL_LINES): string[] {
  const lines = stripAnsi(log).split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.slice(-count);
}

// Vitest's summary: `      Tests  4337 passed | 1 skipped (4338)`.
const VITEST_TESTS = /^\s*Tests\s+(.+?)\s+\(\d+\)\s*$/m;
// Playwright's list reporter: `  12 passed (30.1s)`, `  2 skipped`, `  1 flaky`.
const PLAYWRIGHT_COUNT =
  /^\s+(\d+ (?:passed|failed|flaky|skipped|did not run))\b/gm;

/** The test counts a passing step's log reports ("4337 passed, 1 skipped"), if any. */
export function testCounts(log: string): string | undefined {
  const text = stripAnsi(log);
  const vitest = VITEST_TESTS.exec(text);
  if (vitest) return vitest[1].split(/\s*\|\s*/).join(', ');
  const playwright = [...text.matchAll(PLAYWRIGHT_COUNT)].map((m) => m[1]);
  return playwright.length > 0 ? playwright.join(', ') : undefined;
}

export function seconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

/** `static (docs, format, lint, types)`, or the bare name for a step with no parts. */
export function stepLabel(step: HookStep): string {
  return step.parts.length > 0
    ? `${step.name} (${step.parts.join(', ')})`
    : step.name;
}

/** The one line a passing step prints: `✓ tests 4337 passed, 1 skipped in 98s`. */
export function passLine(step: HookStep, log: string, ms: number): string {
  const counts = testCounts(log);
  return `✓ ${stepLabel(step)}${counts ? ` ${counts}` : ''} in ${seconds(ms)}`;
}

/** A failed step: its label and exit, the tail of its log, and where the whole log is. */
export function failureLines(
  step: HookStep,
  log: string,
  exit: string,
  ms: number,
  logPath: string,
): string[] {
  return [
    `✗ ${stepLabel(step)} failed, ${exit}, after ${seconds(ms)}; the end of its log:`,
    ...tail(log).map((line) => `  ${line}`),
    `✗ ${step.name}: full log ${logPath}`,
  ];
}
