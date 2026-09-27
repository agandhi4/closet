import fs from 'fs';
import path from 'path';

// `npm run docs:check`, part of `npm run check` (so the pre-commit hook and CI).
// The root CLAUDE.md is loaded by every agent session; each area's CLAUDE.md only when a
// file in its directory is read (#104). The budgets keep the root from silently regrowing:
// new knowledge goes to its area's doc, and an area that outgrows its budget splits.
// The index check keeps the root's area index and the docs on disk in step.
const PROJECT_ROOT = path.join(__dirname, '..');
const ROOT_DOC = 'CLAUDE.md';
const ROOT_BUDGET = 48 * 1024;
const AREA_BUDGET = 16 * 1024;
const AREA_TREES = ['src', 'test', 'views', 'scripts', 'docs'];
const SKIPPED_DIRS = new Set(['node_modules']);

function areaDocs(dir: string): string[] {
  const absolute = path.join(PROJECT_ROOT, dir);
  if (!fs.existsSync(absolute)) return [];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory())
      return SKIPPED_DIRS.has(entry.name) ? [] : areaDocs(relative);
    return entry.name === 'CLAUDE.md' ? [relative] : [];
  });
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

const problems: string[] = [];
const rootText = fs.readFileSync(path.join(PROJECT_ROOT, ROOT_DOC), 'utf8');
const rootSize = Buffer.byteLength(rootText);
if (rootSize > ROOT_BUDGET) {
  problems.push(
    `${ROOT_DOC} is ${kb(rootSize)}, over its ${kb(ROOT_BUDGET)} budget: move area detail to the area's CLAUDE.md`,
  );
}

const areas = AREA_TREES.flatMap(areaDocs).map((doc) => ({
  doc,
  size: fs.statSync(path.join(PROJECT_ROOT, doc)).size,
}));
for (const { doc, size } of areas) {
  if (size > AREA_BUDGET) {
    problems.push(
      `${doc} is ${kb(size)}, over the ${kb(AREA_BUDGET)} area budget: split it (a subdirectory's CLAUDE.md or a sibling doc it links)`,
    );
  }
  if (!rootText.includes(`\`${doc}\``)) {
    problems.push(`${doc} is not in ${ROOT_DOC}'s area index`);
  }
}

const named = new Set(
  Array.from(
    rootText.matchAll(/`([\w./-]+\/CLAUDE\.md)`/g),
    (match) => match[1],
  ),
);
for (const doc of named) {
  if (!fs.existsSync(path.join(PROJECT_ROOT, doc))) {
    problems.push(`${ROOT_DOC} names ${doc}, which does not exist`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`docs:check: ${problem}`);
  process.exit(1);
}

const largest = areas.reduce((a, b) => (b.size > a.size ? b : a));
console.log(
  `docs:check: ${ROOT_DOC} ${kb(rootSize)} of ${kb(ROOT_BUDGET)}; ${areas.length} area docs, largest ${largest.doc} ${kb(largest.size)} of ${kb(AREA_BUDGET)}`,
);
